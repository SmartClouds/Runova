import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  createFileWatcher,
  createOpenFileRegistry,
  type FileSignature,
  type FileWatcherDeps,
  OPEN_FILE_DEBOUNCE_MS,
  OPEN_FILE_POLL_MS,
  OPEN_FILE_RETRY_WATCH_MS,
} from './openFileWatcher';

/**
 * The watcher behind the editor's "changed on disk" bar. It has to notice a file an agent rewrote
 * (often by writing a temp file and renaming it over the old one), stay quiet when nothing really
 * changed, and say so when the file is deleted.
 */

const FILE = join('E:', 'work', 'app', '.env.prod');

interface FakeFs {
  deps: Partial<FileWatcherDeps>;
  /** Fires the folder watch's listener, as fs.watch would for a change to `name`. */
  fire: (name: string | null) => void;
  /** Makes the folder watch report an error, as Windows does on an overflow. */
  fail: () => void;
  setFile: (signature: FileSignature | null) => void;
  watchCalls: () => number;
  closes: () => number;
}

function fakeFs(options: { watchThrows?: boolean } = {}): FakeFs {
  let file: FileSignature | null = { mtimeMs: 1, size: 10 };
  let listener: ((event: string, name: string | null) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  let watchCalls = 0;
  let closes = 0;
  let throws = options.watchThrows ?? false;
  return {
    deps: {
      watch: (_dir, next) => {
        watchCalls += 1;
        if (throws) {
          throws = false;
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        listener = next;
        return {
          on: (_event, handler) => {
            onError = handler;
          },
          close: () => {
            closes += 1;
            listener = null;
          },
        };
      },
      stat: async () => file,
      platform: 'win32',
    },
    fire: (name) => listener?.('change', name),
    fail: () => onError?.(new Error('overflow')),
    setFile: (signature) => {
      file = signature;
    },
    watchCalls: () => watchCalls,
    closes: () => closes,
  };
}

/** Lets the watcher's stat promises settle, then runs its timers. */
async function settle(ms = OPEN_FILE_DEBOUNCE_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('createFileWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says when the file changes, after a short quiet period', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.setFile({ mtimeMs: 2, size: 12 });
    fs.fire('.env.prod');
    fs.fire('.env.prod');
    expect(onChange).not.toHaveBeenCalled();
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ exists: true });
    watcher.close();
  });

  it('ignores other files in the same folder', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.setFile({ mtimeMs: 2, size: 12 });
    fs.fire('.env.local');
    await settle();

    expect(onChange).not.toHaveBeenCalled();
    watcher.close();
  });

  it('matches the name regardless of case on Windows', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.setFile({ mtimeMs: 2, size: 12 });
    fs.fire('.ENV.PROD');
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('checks the file when the platform does not say which one changed', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.setFile({ mtimeMs: 2, size: 12 });
    fs.fire(null);
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('stays quiet when the file was only touched by an event, not changed', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.fire('.env.prod');
    await settle();

    expect(onChange).not.toHaveBeenCalled();
    watcher.close();
  });

  it('says when the file is deleted, and again when it comes back', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.setFile(null);
    fs.fire('.env.prod');
    await settle();
    expect(onChange).toHaveBeenLastCalledWith({ exists: false });

    fs.setFile({ mtimeMs: 5, size: 3 });
    fs.fire('.env.prod');
    await settle();
    expect(onChange).toHaveBeenLastCalledWith({ exists: true });
    expect(onChange).toHaveBeenCalledTimes(2);
    watcher.close();
  });

  it('polls when the folder cannot be watched, then watches again later', async () => {
    const fs = fakeFs({ watchThrows: true });
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.setFile({ mtimeMs: 2, size: 12 });
    await settle(OPEN_FILE_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    await settle(OPEN_FILE_RETRY_WATCH_MS);
    expect(fs.watchCalls()).toBe(2);
    watcher.close();
  });

  it('falls back to polling after a watch error', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.fail();
    expect(fs.closes()).toBe(1);
    fs.setFile({ mtimeMs: 2, size: 12 });
    await settle(OPEN_FILE_POLL_MS);

    expect(onChange).toHaveBeenCalledWith({ exists: true });
    watcher.close();
  });

  it('stops everything on close', async () => {
    const fs = fakeFs();
    const onChange = vi.fn();
    const watcher = createFileWatcher(FILE, onChange, fs.deps);
    await settle(0);

    fs.setFile({ mtimeMs: 2, size: 12 });
    fs.fire('.env.prod');
    watcher.close();
    await settle(OPEN_FILE_RETRY_WATCH_MS);

    expect(onChange).not.toHaveBeenCalled();
    expect(fs.closes()).toBe(1);
  });
});

/** A window that can be closed, which is all the registry asks of a sender. */
function fakeSender() {
  const destroyed: (() => void)[] = [];
  const send = vi.fn();
  const sender = {
    send,
    isDestroyed: () => false,
    once: (_event: string, listener: () => void) => {
      destroyed.push(listener);
    },
  } as unknown as WebContents;
  return { sender, send, destroy: () => destroyed.forEach((listener) => listener()) };
}

describe('createOpenFileRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pushes a change to each window watching the file, under the path it asked for', async () => {
    const fs = fakeFs();
    const registry = createOpenFileRegistry(fs.deps);
    const one = fakeSender();
    const two = fakeSender();
    registry.watch('e:\\work\\app\\.env.prod', FILE, one.sender);
    registry.watch('e:\\work\\app\\.env.prod', FILE, two.sender);
    await settle(0);
    expect(fs.watchCalls()).toBe(1);

    fs.setFile({ mtimeMs: 2, size: 12 });
    fs.fire('.env.prod');
    await settle();

    for (const window of [one, two]) {
      expect(window.send).toHaveBeenCalledWith(IPC.fs.onFileChanged, 'e:\\work\\app\\.env.prod', {
        exists: true,
      });
    }
    registry.dispose();
  });

  it('keeps watching until the last tab showing the file lets go', async () => {
    const fs = fakeFs();
    const registry = createOpenFileRegistry(fs.deps);
    const window = fakeSender();
    // Two panes in one window show the same file.
    registry.watch(FILE, FILE, window.sender);
    registry.watch(FILE, FILE, window.sender);

    registry.unwatch(FILE, window.sender);
    expect(fs.closes()).toBe(0);
    expect(registry.size()).toBe(1);

    registry.unwatch(FILE, window.sender);
    expect(fs.closes()).toBe(1);
    expect(registry.size()).toBe(0);
  });

  it('lets go of everything a window watched when it closes', async () => {
    const fs = fakeFs();
    const registry = createOpenFileRegistry(fs.deps);
    const window = fakeSender();
    registry.watch(FILE, FILE, window.sender);
    registry.watch(`${FILE}.bak`, `${FILE}.bak`, window.sender);
    expect(registry.size()).toBe(2);

    window.destroy();
    expect(registry.size()).toBe(0);
  });

  it('ignores an unwatch for a file nobody watches', () => {
    const registry = createOpenFileRegistry(fakeFs().deps);
    expect(() => registry.unwatch(FILE, fakeSender().sender)).not.toThrow();
  });
});

describe('createFileWatcher on a real folder', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runova-open-file-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('notices a write made by renaming a temp file over the original', async () => {
    const path = join(dir, '.env.prod');
    writeFileSync(path, 'A=1\n');
    const onChange = vi.fn();
    const watcher = createFileWatcher(path, onChange);
    await vi.waitFor(() => expect(watcher.ready()).toBe(true));

    // How agents and many editors save: write a sibling, then swap it in.
    const temp = join(dir, '.env.prod.tmp-1');
    writeFileSync(temp, 'A=2\nB=3\n');
    renameSync(temp, path);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ exists: true }), {
      timeout: 5000,
    });

    unlinkSync(path);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ exists: false }), {
      timeout: 5000,
    });
    watcher.close();
  });
});
