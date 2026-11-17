import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalClipboardPaste } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { withPlatform } from '../../test/main/fixtures';
import {
  electronState,
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Pasting something other than text into a terminal. The part that matters for the sandbox is
 * where the bytes land: a pasted screenshot is written under the app's own userData folder and
 * nowhere else, however the renderer names it.
 *
 * The clipboard and the image decoder are the OS boundary here. Clipboard contents are set
 * through the electron stand-in's state. The stand-in's image decoder has no pictures in it, so
 * each test replaces it on the very copy of the stand-in the handler module imported, which is
 * the copy this test also gets from `import('electron')`.
 */

interface FakeImage {
  isEmpty: () => boolean;
  toPNG: () => Buffer;
  toDataURL: () => string;
  getSize: () => { width: number; height: number };
  resize: (options: { width: number; height: number; quality?: string }) => FakeImage;
}

interface ClipboardStandIn {
  clipboard: {
    readText: () => Promise<string>;
  };
  nativeImage: { createFromPath: (path: string) => FakeImage };
}

const userData = useTempUserData();
/** The stand-in the handler module itself imported, so patching it is what the handler sees. */
let electron: ClipboardStandIn;
const resizes: { width: number; height: number }[] = [];

expectChannelsCovered(IPC.terminalClipboard);

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function fakeImage(width = 32, height = 32): FakeImage {
  const image: FakeImage = {
    isEmpty: () => false,
    toPNG: () => PNG_BYTES,
    toDataURL: () => `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    getSize: () => ({ width, height }),
    resize: (options) => {
      resizes.push({ width: options.width, height: options.height });
      return fakeImage(options.width, options.height);
    },
  };
  return image;
}

function pastedPath(name: string): string {
  return join(userData.dir, 'pasted-images', name);
}

beforeEach(async () => {
  resizes.length = 0;
  await loadIpc(
    () => import('./terminalClipboard'),
    (module) => module.registerTerminalClipboardHandlers(),
  );
  electron = (await import('electron')) as unknown as ClipboardStandIn;
});

describe('terminalClipboard:saveImage', () => {
  it('writes the image under the app data folder and hands back its path', async () => {
    const path = await invoke<string>(IPC.terminalClipboard.saveImage, PNG_BYTES, 'image/png');
    expect(path.startsWith(join(userData.dir, 'pasted-images'))).toBe(true);
    expect(path).toMatch(/pasted-\d{4}-\d{2}-\d{2}T[\d-]+-[0-9a-f]{6}\.png$/);
    expect(readFileSync(path)).toEqual(PNG_BYTES);
  });

  it('uses the extension the mime type asks for', async () => {
    const path = await invoke<string>(IPC.terminalClipboard.saveImage, PNG_BYTES, 'image/jpeg');
    expect(path.endsWith('.jpg')).toBe(true);
  });

  it('refuses anything that is not image bytes', async () => {
    await expect(
      invoke(IPC.terminalClipboard.saveImage, 'a string of bytes', 'image/png'),
    ).rejects.toThrow('Nothing to save.');
    await expect(
      invoke(IPC.terminalClipboard.saveImage, new Uint8Array(0), 'image/png'),
    ).rejects.toThrow('Nothing to save.');
    await expect(
      invoke(IPC.terminalClipboard.saveImage, PNG_BYTES, 'application/pdf'),
    ).rejects.toThrow('Only images can be pasted as files.');
    await expect(invoke(IPC.terminalClipboard.saveImage, PNG_BYTES, 42)).rejects.toThrow(
      'Only images can be pasted as files.',
    );
  });

  it('refuses an image past the paste limit instead of writing 25 MB', async () => {
    const tooBig = new Uint8Array(25 * 1024 * 1024 + 1);
    await expect(invoke(IPC.terminalClipboard.saveImage, tooBig, 'image/png')).rejects.toThrow(
      'That image is too large to paste.',
    );
  });

  it('sweeps out images older than a week, and keeps the recent ones', async () => {
    mkdirSync(join(userData.dir, 'pasted-images'), { recursive: true });
    const old = pastedPath('pasted-old.png');
    const recent = pastedPath('pasted-recent.png');
    writeFileSync(old, PNG_BYTES);
    writeFileSync(recent, PNG_BYTES);
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);

    await invoke<string>(IPC.terminalClipboard.saveImage, PNG_BYTES, 'image/png');
    // The sweep runs alongside the write rather than blocking it.
    await vi.waitFor(() => expect(existsSync(old)).toBe(false));
    expect(existsSync(recent)).toBe(true);
  });
});

describe('terminalClipboard:previewImage', () => {
  it('reads a file that nativeImage does not handle straight off disk', async () => {
    const path = join(userData.dir, 'shot.webp');
    writeFileSync(path, PNG_BYTES);
    expect(await invoke<string | null>(IPC.terminalClipboard.previewImage, path, false)).toBe(
      `data:image/webp;base64,${PNG_BYTES.toString('base64')}`,
    );
  });

  it('sends the full-size view as the bytes on disk, without resizing', async () => {
    const path = join(userData.dir, 'full.png');
    writeFileSync(path, PNG_BYTES);
    expect(await invoke<string | null>(IPC.terminalClipboard.previewImage, path, true)).toBe(
      `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
    );
    expect(resizes).toEqual([]);
  });

  it('scales a large hover preview down to the longest side', async () => {
    const path = join(userData.dir, 'big.png');
    writeFileSync(path, PNG_BYTES);
    electron.nativeImage.createFromPath = () => fakeImage(1920, 1080);

    const preview = await invoke<string | null>(IPC.terminalClipboard.previewImage, path, false);
    expect(preview).toContain('data:image/png;base64,');
    expect(resizes).toEqual([{ width: 480, height: 270 }]);
  });

  it('leaves a picture that already fits alone', async () => {
    const path = join(userData.dir, 'small.png');
    writeFileSync(path, PNG_BYTES);
    electron.nativeImage.createFromPath = () => fakeImage(120, 80);

    expect(await invoke<string | null>(IPC.terminalClipboard.previewImage, path, false)).toContain(
      'data:image/png;base64,',
    );
    expect(resizes).toEqual([]);
  });

  it('answers null for anything that is not an image file it can show', async () => {
    const notAnImage = join(userData.dir, 'notes.txt');
    writeFileSync(notAnImage, 'hello', 'utf-8');
    expect(await invoke(IPC.terminalClipboard.previewImage, notAnImage, false)).toBeNull();
    expect(
      await invoke(IPC.terminalClipboard.previewImage, join(userData.dir, 'gone.png'), false),
    ).toBeNull();
    // A folder named like an image, and a path that is not a string at all.
    expect(await invoke(IPC.terminalClipboard.previewImage, userData.dir, false)).toBeNull();
    expect(await invoke(IPC.terminalClipboard.previewImage, 42, false)).toBeNull();
  });
});

describe('terminalClipboard:read', () => {
  it('prefers the text, which is what a copy from a web page means', async () => {
    electronState.clipboardText = 'npm run dev';
    electronState.clipboardFormats = { 'image/png': PNG_BYTES };
    expect(await invoke<TerminalClipboardPaste | null>(IPC.terminalClipboard.read)).toEqual({
      kind: 'text',
      text: 'npm run dev',
    });
  });

  it('saves a copied screenshot into the app data folder and pastes its path', async () => {
    electronState.clipboardText = '';
    electronState.clipboardFormats = { 'image/png': PNG_BYTES };

    const paste = await invoke<TerminalClipboardPaste | null>(IPC.terminalClipboard.read);
    expect(paste?.kind).toBe('files');
    const path = paste?.kind === 'files' ? paste.paths[0] : '';
    expect(path.startsWith(join(userData.dir, 'pasted-images'))).toBe(true);
    expect(readFileSync(path)).toEqual(PNG_BYTES);
  });

  it('answers null when the clipboard holds nothing a terminal can use', async () => {
    electronState.clipboardText = '';
    expect(await invoke(IPC.terminalClipboard.read)).toBeNull();
  });

  it('pastes the paths of files copied in Explorer, ahead of any text', async () => {
    electronState.clipboardText = 'some stale text';
    electronState.clipboardFormats = {
      'text/uri-list': 'file:///C:/shots/screen.png\r\nfile:///C:/shots/my%20notes.txt',
    };

    const paste = await withPlatform('win32', () =>
      invoke<TerminalClipboardPaste | null>(IPC.terminalClipboard.read),
    );
    expect(paste).toEqual({
      kind: 'files',
      paths: ['C:\\shots\\screen.png', 'C:\\shots\\my notes.txt'],
    });
  });

  it('pastes copied files as text away from Windows', async () => {
    electronState.clipboardText = 'plain text';
    electronState.clipboardFormats = { 'text/uri-list': 'file:///tmp/screen.png' };

    expect(
      await withPlatform('darwin', () =>
        invoke<TerminalClipboardPaste | null>(IPC.terminalClipboard.read),
      ),
    ).toEqual({ kind: 'text', text: 'plain text' });
  });
});
