import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidPhrase } from '@runova/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  electronState,
  FakeBrowserWindow,
  fakeWebContents,
  queueDialog,
} from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The recovery phrase channels (E107): a page asks for a phrase, shows its words, and copies,
 * saves or shows it as a QR code by id. Only the id ever comes back from the page.
 */

const userData = useTempUserData();

const PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';

let window: FakeBrowserWindow;
let sender: ReturnType<typeof fakeWebContents>;
let registry: Awaited<ReturnType<typeof importPhrase>>['phraseRegistry'];
const destroyed: (() => void)[] = [];

const importPhrase = () => import('../phrase');

async function create(purpose = 'vault', label = 'Vault') {
  return invokeFrom<{ id: string; words: string[] }>(sender, IPC.phrase.create, { purpose, label });
}

describe('phrase channels', () => {
  beforeEach(async () => {
    window = new FakeBrowserWindow();
    destroyed.length = 0;
    sender = Object.assign(window.webContents, {
      once: (event: string, listener: unknown) => {
        if (event === 'destroyed') destroyed.push(listener as () => void);
      },
    });
    await loadIpc(
      () => import('./phrase'),
      (module) => module.registerPhraseHandlers(),
    );
    registry = (await importPhrase()).phraseRegistry;
  });

  afterEach(() => vi.useRealTimers());

  it('makes a new phrase for the window that asks and forgets it when the window goes', async () => {
    const made = await create();

    expect(made.words).toHaveLength(24);
    expect(isValidPhrase(made.words.join(' '))).toBe(true);
    expect(registry.peek(made.id, sender.id)).not.toBeNull();

    for (const listener of destroyed) listener();
    expect(registry.peek(made.id)).toBeNull();
  });

  it('refuses a purpose it does not know and a label that is too long', async () => {
    await expect(
      invokeFrom(sender, IPC.phrase.create, { purpose: 'wallet', label: 'x' }),
    ).rejects.toThrow('not valid');
    await expect(
      invokeFrom(sender, IPC.phrase.create, { purpose: 'vault', label: 'x'.repeat(200) }),
    ).rejects.toThrow('not valid');
  });

  it('draws the QR code as a picture, so its text never goes back to the page', async () => {
    const made = await create('sync', 'Personal');

    const qr = await invokeFrom<{ dataUrl: string }>(sender, IPC.phrase.qr, { id: made.id });

    expect(qr.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(qr.dataUrl.split(',')[1] as string, 'base64').toString('utf-8');
    expect(svg).toContain('<svg');
    expect(svg).not.toContain(made.words[0] as string);
  });

  it('copies the phrase and clears the clipboard after the vault setting, if it is still there', async () => {
    userData.writeData('settings.json', { vaultClipboardClearSeconds: 90 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const made = await create();

    const copied = await invokeFrom<{ clearsAt: number }>(sender, IPC.phrase.copy, { id: made.id });

    expect(electronState.clipboardText).toBe(made.words.join(' '));
    expect(copied.clearsAt - Date.now()).toBe(90_000);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(electronState.clipboardText).toBe('');
  });

  it('still clears a phrase after a minute when the vault is set never to clear', async () => {
    userData.writeData('settings.json', { vaultClipboardClearSeconds: 0 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const made = await create();

    await invokeFrom(sender, IPC.phrase.copy, { id: made.id });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(electronState.clipboardText).toBe('');
  });

  it('saves the phrase to a text file only the user can read', async () => {
    const made = await create('server-backup', 'web-1');
    const target = join(userData.dir, 'phrase.txt');
    queueDialog('showSaveDialog', { canceled: false, filePath: target });

    const saved = await invokeFrom<{ path: string } | null>(sender, IPC.phrase.save, {
      id: made.id,
    });

    expect(saved).toEqual({ path: target });
    const text = readFileSync(target, 'utf-8');
    expect(text).toContain('Opens: The backups of a server');
    expect(text).toContain(` 1. ${made.words[0]}`);
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600);
    const call = electronState.dialogCalls.at(-1);
    expect(JSON.stringify(call?.args)).toMatch(
      /Runova recovery phrase - web-1 - \d{4}-\d{2}-\d{2}\.txt/,
    );
  });

  it('saves nothing when the save dialog is cancelled', async () => {
    const made = await create();
    queueDialog('showSaveDialog', { canceled: true });

    expect(await invokeFrom(sender, IPC.phrase.save, { id: made.id })).toBeNull();
  });

  it('reads a phrase back from a saved file to fill an unlock field', async () => {
    const file = join(userData.dir, 'saved.txt');
    writeFileSync(
      file,
      PHRASE.split(' ')
        .map((w, i) => `${i + 1}. ${w}`)
        .join('\n'),
    );
    queueDialog('showOpenDialog', { canceled: false, filePaths: [file] });

    expect(await invokeFrom(sender, IPC.phrase.open)).toEqual({ phrase: PHRASE });
  });

  it('says so when the chosen file has no phrase, and stops at large files', async () => {
    const empty = join(userData.dir, 'notes.txt');
    writeFileSync(empty, 'nothing here');
    queueDialog('showOpenDialog', { canceled: false, filePaths: [empty] });
    await expect(invokeFrom(sender, IPC.phrase.open)).rejects.toThrow(/no recovery phrase/);

    const big = join(userData.dir, 'big.txt');
    writeFileSync(big, 'a'.repeat(70_000));
    queueDialog('showOpenDialog', { canceled: false, filePaths: [big] });
    await expect(invokeFrom(sender, IPC.phrase.open)).rejects.toThrow(/too large/);

    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invokeFrom(sender, IPC.phrase.open)).toBeNull();
  });

  it('forgets a phrase the page is done with', async () => {
    const made = await create();

    await invokeFrom(sender, IPC.phrase.discard, { id: made.id });

    expect(registry.peek(made.id)).toBeNull();
  });

  it('keeps another window from using a phrase it did not ask for', async () => {
    const made = await create();
    const other = new FakeBrowserWindow().webContents;

    await expect(invokeFrom(other, IPC.phrase.copy, { id: made.id })).rejects.toThrow(
      /no longer there/,
    );
    await expect(invokeFrom(other, IPC.phrase.qr, { id: made.id })).rejects.toThrow(
      /no longer there/,
    );
    await invokeFrom(other, IPC.phrase.discard, { id: made.id });
    expect(registry.peek(made.id)).not.toBeNull();
  });

  it('hides the window from screenshots while any phrase is on screen', async () => {
    await invokeFrom(sender, IPC.phrase.protect, { on: true });
    await invokeFrom(sender, IPC.phrase.protect, { on: true });
    expect(window.contentProtected).toBe(true);

    await invokeFrom(sender, IPC.phrase.protect, { on: false });
    expect(window.contentProtected).toBe(true);
    await invokeFrom(sender, IPC.phrase.protect, { on: false });
    expect(window.contentProtected).toBe(false);

    await invokeFrom(sender, IPC.phrase.protect, { on: false });
    expect(window.contentProtected).toBe(false);
  });

  it('refuses a request that is not an object, without naming a field', async () => {
    await expect(invokeFrom(sender, IPC.phrase.qr, 'not an object')).rejects.toThrow(
      /^That request is not valid\.$/,
    );
  });

  it('saves nothing when the save dialog gives back no path', async () => {
    const made = await create();
    queueDialog('showSaveDialog', { canceled: false });

    expect(await invokeFrom(sender, IPC.phrase.save, { id: made.id })).toBeNull();
  });

  it('opens its dialogs on their own when the page has no window of its own', async () => {
    const page = Object.assign(fakeWebContents(), { once: () => undefined });
    const made = await invokeFrom<{ id: string }>(page, IPC.phrase.create, {
      purpose: 'vault',
      label: 'Vault',
    });
    const target = join(userData.dir, 'windowless.txt');
    queueDialog('showSaveDialog', { canceled: false, filePath: target });

    expect(await invokeFrom(page, IPC.phrase.save, { id: made.id })).toEqual({ path: target });
    expect(electronState.dialogCalls.at(-1)?.args).toHaveLength(1);

    writeFileSync(
      target,
      PHRASE.split(' ')
        .map((w, i) => `${i + 1}. ${w}`)
        .join('\n'),
    );
    queueDialog('showOpenDialog', { canceled: false, filePaths: [target] });
    expect(await invokeFrom(page, IPC.phrase.open)).toEqual({ phrase: PHRASE });
    expect(electronState.dialogCalls.at(-1)?.args).toHaveLength(1);

    // With no window there is nothing to hide from screenshots, and nothing throws.
    await expect(invokeFrom(page, IPC.phrase.protect, { on: true })).resolves.toBeUndefined();
  });
});

expectChannelsCovered(IPC.phrase);
