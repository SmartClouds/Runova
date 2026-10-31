import { watch as fsWatch } from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { WebContents } from 'electron';
import type { FileDiskChange } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { sendToContents } from '../ipc/send';

/**
 * Tells an editor tab when its file changes on disk, so an agent's edit shows up without a
 * manual reload. The working tree watcher can't do this job: it only speaks when the git status
 * changes, which a gitignored file like `.env.prod` never does.
 *
 * Each file is watched through its folder, not on its own. Agents and many editors save by
 * writing a temp file and renaming it over the original, and a watch on the file itself follows
 * the old copy that just got replaced. An event only counts when a stat shows the file really
 * changed (or appeared, or went away), so a doubled or stray event is harmless. Where the folder
 * can't be watched (it's gone, or the watch errors) the file is polled until watching works again.
 */

/** Quiet period before a burst of events counts as settled. A save is often two or three. */
export const OPEN_FILE_DEBOUNCE_MS = 150;
/** How often the file is polled while its folder can't be watched. */
export const OPEN_FILE_POLL_MS = 2000;
/** How long after a failed watch watching is tried again. */
export const OPEN_FILE_RETRY_WATCH_MS = 10_000;

/** What a stat says about the file, enough to tell a real change from a stray event. */
export interface FileSignature {
  mtimeMs: number;
  size: number;
}

export interface WatchHandle {
  on: (event: 'error', listener: (error: Error) => void) => unknown;
  close: () => void;
}

export interface FileWatcherDeps {
  /** Watches one folder, without recursion. */
  watch: (dir: string, listener: (event: string, file: string | null) => void) => WatchHandle;
  /** Null when the file isn't there. */
  stat: (path: string) => Promise<FileSignature | null>;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  platform: NodeJS.Platform;
}

export interface FileWatcher {
  /** True once the file's starting state is known, so a change after this is reported. */
  ready: () => boolean;
  close: () => void;
}

const defaultDeps: FileWatcherDeps = {
  watch: (dir, listener) =>
    fsWatch(dir, { persistent: false }, (event, file) =>
      listener(event, file === null ? null : String(file)),
    ),
  stat: async (path) => {
    try {
      const info = await fsStat(path);
      return { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return null;
    }
  },
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  platform: process.platform,
};

function sameSignature(a: FileSignature | null, b: FileSignature | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Starts watching `path`. `onChange` runs each time the file is found changed, created or gone. */
export function createFileWatcher(
  path: string,
  onChange: (change: FileDiskChange) => void,
  overrides: Partial<FileWatcherDeps> = {},
): FileWatcher {
  const deps: FileWatcherDeps = { ...defaultDeps, ...overrides };
  const dir = dirname(path);
  // Windows and macOS file names don't care about case, so neither does the match.
  const foldCase = deps.platform !== 'linux';
  const name = foldCase ? basename(path).toLowerCase() : basename(path);

  let closed = false;
  let isReady = false;
  let last: FileSignature | null = null;
  let watcher: WatchHandle | null = null;
  let debounce: unknown = null;
  let pollTimer: unknown = null;
  let retryTimer: unknown = null;

  // Checks run one after another, so two stats never race to set `last`.
  let queue: Promise<void> = deps.stat(path).then((signature) => {
    last = signature;
    isReady = true;
  });

  function check(): void {
    queue = queue.then(async () => {
      if (closed) return;
      const next = await deps.stat(path);
      if (closed || sameSignature(next, last)) return;
      last = next;
      try {
        onChange({ exists: next !== null });
      } catch {
        // A failing listener must not stop the watching.
      }
    });
  }

  function schedule(): void {
    if (debounce !== null) deps.clearTimeout(debounce);
    debounce = deps.setTimeout(() => {
      debounce = null;
      check();
    }, OPEN_FILE_DEBOUNCE_MS);
  }

  function matches(file: string | null): boolean {
    // Some platforms don't say which file changed. A stat is cheap.
    if (file === null) return true;
    return (foldCase ? file.toLowerCase() : file) === name;
  }

  function poll(): void {
    pollTimer = null;
    if (closed) return;
    check();
    pollTimer = deps.setTimeout(poll, OPEN_FILE_POLL_MS);
  }

  function stopPolling(): void {
    if (pollTimer !== null) deps.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function fallBack(): void {
    if (closed) return;
    watcher?.close();
    watcher = null;
    pollTimer ??= deps.setTimeout(poll, OPEN_FILE_POLL_MS);
    retryTimer ??= deps.setTimeout(() => {
      retryTimer = null;
      startWatching();
    }, OPEN_FILE_RETRY_WATCH_MS);
  }

  function startWatching(): void {
    if (closed) return;
    let handle: WatchHandle;
    try {
      handle = deps.watch(dir, (_event, file) => {
        if (!closed && matches(file)) schedule();
      });
    } catch {
      fallBack();
      return;
    }
    watcher = handle;
    handle.on('error', () => fallBack());
    if (pollTimer !== null) {
      stopPolling();
      // Something may have changed between the last poll and the watch starting.
      check();
    }
  }

  startWatching();

  return {
    ready: () => isReady,
    close: () => {
      if (closed) return;
      closed = true;
      stopPolling();
      for (const timer of [debounce, retryTimer]) if (timer !== null) deps.clearTimeout(timer);
      debounce = null;
      retryTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}

interface OpenFile {
  watcher: FileWatcher;
  /** How many tabs in each window show the file. */
  subscribers: Map<WebContents, number>;
}

export interface OpenFileRegistry {
  /**
   * One more tab in `sender` shows the file. `key` is the path as the renderer gave it, which is
   * what the push carries back; `target` is the checked path that is actually watched.
   */
  watch: (key: string, target: string, sender: WebContents) => void;
  unwatch: (key: string, sender: WebContents) => void;
  /** How many files are being watched. For tests. */
  size: () => number;
  dispose: () => void;
}

export function createOpenFileRegistry(overrides: Partial<FileWatcherDeps> = {}): OpenFileRegistry {
  const files = new Map<string, OpenFile>();
  const trackedSenders = new WeakSet<WebContents>();

  function drop(key: string, sender: WebContents, all: boolean): void {
    const entry = files.get(key);
    if (!entry) return;
    const count = entry.subscribers.get(sender) ?? 0;
    if (all || count <= 1) entry.subscribers.delete(sender);
    else entry.subscribers.set(sender, count - 1);
    if (entry.subscribers.size === 0) {
      entry.watcher.close();
      files.delete(key);
    }
  }

  function trackSender(sender: WebContents): void {
    if (trackedSenders.has(sender)) return;
    trackedSenders.add(sender);
    sender.once('destroyed', () => {
      for (const key of [...files.keys()]) drop(key, sender, true);
    });
  }

  return {
    watch: (key, target, sender) => {
      trackSender(sender);
      const existing = files.get(key);
      if (existing) {
        existing.subscribers.set(sender, (existing.subscribers.get(sender) ?? 0) + 1);
        return;
      }
      const subscribers = new Map<WebContents, number>([[sender, 1]]);
      const watcher = createFileWatcher(
        target,
        (change) => {
          for (const one of subscribers.keys()) {
            sendToContents(one, IPC.fs.onFileChanged, key, change);
          }
        },
        overrides,
      );
      files.set(key, { watcher, subscribers });
    },
    unwatch: (key, sender) => drop(key, sender, false),
    size: () => files.size,
    dispose: () => {
      for (const entry of files.values()) entry.watcher.close();
      files.clear();
    },
  };
}

/** The app's one registry, used by the fs IPC handlers. */
export const openFiles = createOpenFileRegistry();
