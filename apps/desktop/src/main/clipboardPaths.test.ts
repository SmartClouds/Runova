import { describe, expect, it } from 'vitest';
import { withPlatform } from '../test/main/fixtures';
import { electronState } from '../test/main/ipcHarness';
import { rawFormat } from './clipboardData';
import { copiedFiles, osClipboardPaths } from './clipboardPaths';

/**
 * The OS clipboard's file list, read the way Explorer, Finder and a Linux file manager each put
 * it there. Shared by the RDP clipboard sync and the workspace explorer's paste-from-OS feature,
 * so it is tested on its own rather than through either of those. Clipboard contents are set
 * through the electron stand-in's state, as `clipboard.read()` lists them.
 */

describe('osClipboardPaths on win32', () => {
  it('reads every path out of the uri-list Electron makes of an Explorer copy', async () => {
    electronState.clipboardFormats = {
      'text/uri-list': 'file:///C:/pics/a.png\r\nfile:///C:/pics/b%20%23%20%C3%BC.png',
    };

    const paths = await withPlatform('win32', osClipboardPaths);

    expect(paths).toEqual(['C:\\pics\\a.png', 'C:\\pics\\b # ü.png']);
  });

  it('reads a copy from a network share as a UNC path', async () => {
    electronState.clipboardFormats = { 'text/uri-list': 'file://server/share/report.pdf' };

    const paths = await withPlatform('win32', osClipboardPaths);

    expect(paths).toEqual(['\\\\server\\share\\report.pdf']);
  });

  it('returns no paths when the clipboard carries text only', async () => {
    // Every paste in the explorer asks, and most of the time the clipboard holds text.
    electronState.clipboardText = 'C:\\pics\\a.png';

    const paths = await withPlatform('win32', osClipboardPaths);

    expect(paths).toEqual([]);
  });
});

describe('osClipboardPaths on darwin', () => {
  it('reads the uri-list first, when Electron lists one', async () => {
    electronState.clipboardFormats = {
      'text/uri-list': 'file:///Users/me/a.png',
      [rawFormat('NSFilenamesPboardType')]: '<string>/Users/me/other.png</string>',
    };

    const paths = await withPlatform('darwin', osClipboardPaths);

    expect(paths).toEqual(['/Users/me/a.png']);
  });

  it('reads every path out of the NSFilenamesPboardType plist, unescaping its XML entities', async () => {
    electronState.clipboardFormats = {
      [rawFormat('NSFilenamesPboardType')]:
        '<string>/Users/me/a &amp; b.png</string><string>/Users/me/c.png</string>',
    };

    const paths = await withPlatform('darwin', osClipboardPaths);

    expect(paths).toEqual(['/Users/me/a & b.png', '/Users/me/c.png']);
  });

  it('falls back to the single public.file-url when there is no plist', async () => {
    electronState.clipboardFormats = {
      [rawFormat('public.file-url')]: Buffer.from('file:///Users/me/shot.png\0'),
    };

    const paths = await withPlatform('darwin', osClipboardPaths);

    expect(paths).toEqual(['/Users/me/shot.png']);
  });

  it('returns no paths when no file format holds anything', async () => {
    const paths = await withPlatform('darwin', osClipboardPaths);

    expect(paths).toEqual([]);
  });
});

describe('osClipboardPaths on linux', () => {
  it('reads every file:// line out of text/uri-list', async () => {
    electronState.clipboardFormats = {
      'text/uri-list': 'file:///home/me/a.png\r\nfile:///home/me/b.png\r\n',
    };

    const paths = await withPlatform('linux', osClipboardPaths);

    expect(paths).toEqual(['/home/me/a.png', '/home/me/b.png']);
  });

  it('falls back to x-special/gnome-copied-files when there is no uri-list', async () => {
    electronState.clipboardFormats = {
      'x-special/gnome-copied-files': 'copy\nfile:///home/me/c.png',
    };

    const paths = await withPlatform('linux', osClipboardPaths);

    expect(paths).toEqual(['/home/me/c.png']);
  });

  it('reads gnome-copied-files listed as a raw format too', async () => {
    electronState.clipboardFormats = {
      [rawFormat('x-special/gnome-copied-files')]: 'cut\nfile:///home/me/d.png',
    };

    const paths = await withPlatform('linux', osClipboardPaths);

    expect(paths).toEqual(['/home/me/d.png']);
  });

  it('ignores anything that is not a file:// line', async () => {
    electronState.clipboardFormats = {
      'text/uri-list': 'not-a-uri\r\nfile:///home/me/ok.png\r\n',
    };

    const paths = await withPlatform('linux', osClipboardPaths);

    expect(paths).toEqual(['/home/me/ok.png']);
  });

  it('returns no paths when no file format holds anything', async () => {
    const paths = await withPlatform('linux', osClipboardPaths);

    expect(paths).toEqual([]);
  });
});

describe('copiedFiles', () => {
  it('names the format the list came from, so a signature changes with it', async () => {
    electronState.clipboardFormats = { 'text/uri-list': 'file:///home/me/a.png\n' };

    expect(await withPlatform('linux', copiedFiles)).toEqual({
      format: 'text/uri-list',
      text: 'file:///home/me/a.png',
    });
  });

  it('is null when the clipboard cannot be read at all', async () => {
    const electron = (await import('electron')) as unknown as {
      clipboard: { read: () => Promise<unknown> };
    };
    const read = electron.clipboard.read;
    electron.clipboard.read = () => Promise.reject(new Error('clipboard busy'));
    try {
      expect(await withPlatform('win32', copiedFiles)).toBeNull();
    } finally {
      electron.clipboard.read = read;
    }
  });
});
