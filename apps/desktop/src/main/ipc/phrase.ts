import { readFile, stat, writeFile } from 'node:fs/promises';
import { PHRASE_PURPOSES, phraseQrPayload } from '@runova/protocol';
import { BrowserWindow, clipboard, dialog, type IpcMainInvokeEvent, ipcMain } from 'electron';
import QRCode from 'qrcode';
import { z } from 'zod';
import { IPC } from '../../shared/ipcChannels';
import { phraseRegistry } from '../phrase';
import { phraseFileName, phraseFileText, readPhraseFile } from '../phrase/file';
import { store } from '../store';
import { ClipboardGuard } from '../vault/clipboardGuard';

/**
 * Recovery phrase channels (E107). A phrase is made and kept here; the page gets its words to show
 * and an id for everything else, so the QR code, the clipboard and the saved file never need the
 * words to come back from the page.
 */

const MAX_FILE_BYTES = 64 * 1024;
const FALLBACK_CLEAR_SECONDS = 60;

const id = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join('.');
  throw new Error(`That request is not valid${field ? ` (${field})` : ''}.`);
}

function held(event: IpcMainInvokeEvent, phraseId: string) {
  const phrase = phraseRegistry.peek(phraseId, event.sender.id);
  if (!phrase)
    throw new Error('That recovery phrase is no longer there. Make a new one and try again.');
  return phrase;
}

export function registerPhraseHandlers(): void {
  const watched = new Set<number>();
  const protecting = new Map<number, number>();
  const guard = new ClipboardGuard(clipboard, () => undefined);

  const watch = (event: IpcMainInvokeEvent) => {
    const owner = event.sender.id;
    if (watched.has(owner)) return;
    watched.add(owner);
    event.sender.once('destroyed', () => {
      watched.delete(owner);
      protecting.delete(owner);
      phraseRegistry.discardOwnedBy(owner);
    });
  };

  ipcMain.handle(IPC.phrase.create, (event, payload: unknown) => {
    const input = parse(
      z.strictObject({ purpose: z.enum(PHRASE_PURPOSES), label: z.string().max(120) }),
      payload,
    );
    watch(event);
    return phraseRegistry.create({ ...input, owner: event.sender.id });
  });

  ipcMain.handle(IPC.phrase.qr, async (event, payload: unknown) => {
    const phrase = held(event, parse(id, payload).id);
    const svg = await QRCode.toString(phraseQrPayload(phrase), {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
    });
    return { dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}` };
  });

  ipcMain.handle(IPC.phrase.copy, async (event, payload: unknown) => {
    const phrase = held(event, parse(id, payload).id);
    const seconds = (await store.getSettings()).vaultClipboardClearSeconds;
    return guard.copy(phrase.phrase, (seconds > 0 ? seconds : FALLBACK_CLEAR_SECONDS) * 1000);
  });

  ipcMain.handle(IPC.phrase.save, async (event, payload: unknown) => {
    const phrase = held(event, parse(id, payload).id);
    const made = new Date();
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Save your recovery phrase',
      defaultPath: phraseFileName(phrase.label, made),
      filters: [{ name: 'Text', extensions: ['txt'] }],
    };
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, phraseFileText({ ...phrase, made }), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    return { path: result.filePath };
  });

  ipcMain.handle(IPC.phrase.open, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Open a saved recovery phrase',
      properties: ['openFile' as const],
      filters: [{ name: 'Text', extensions: ['txt'] }],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    if ((await stat(path)).size > MAX_FILE_BYTES) {
      throw new Error('That file is too large to be a saved recovery phrase.');
    }
    const phrase = readPhraseFile(await readFile(path, 'utf-8'));
    if (!phrase) throw new Error('That file has no recovery phrase in it.');
    return { phrase };
  });

  ipcMain.handle(IPC.phrase.discard, (event, payload: unknown) => {
    phraseRegistry.discard(parse(id, payload).id, event.sender.id);
  });

  ipcMain.handle(IPC.phrase.protect, (event, payload: unknown) => {
    const { on } = parse(z.strictObject({ on: z.boolean() }), payload);
    const owner = event.sender.id;
    const count = Math.max(0, (protecting.get(owner) ?? 0) + (on ? 1 : -1));
    protecting.set(owner, count);
    watch(event);
    BrowserWindow.fromWebContents(event.sender)?.setContentProtection(count > 0);
  });
}
