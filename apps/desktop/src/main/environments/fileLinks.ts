import { MAX_ENV_FILE_BYTES } from '@runova/core';
import type { EnvFileLinkState } from '../../shared/apiTypes';
import type { FileSignature } from '../fs/openFileWatcher';
import { VaultLockedError } from '../ssh/vaultErrors';

/**
 * Keeps env files saved in Runova in step with the files they are linked to in the project folder.
 * Each linked file is watched; when one changes, its saved copy takes the new contents and the
 * old ones go into the history.
 *
 * What was last seen of each file on disk (its size and time, never its contents) is remembered
 * on this computer. At start a file only counts as changed when that differs, so a copy synced in
 * from another computer isn't undone by an older file that nobody touched here.
 */

export interface LinkedEnvFile {
  projectId: string;
  environmentId: string;
  fileId: string;
  /** Absolute. Null when the project has no folder on this computer. */
  path: string | null;
}

/**
 * What an update from disk did. `gone` means the saved file or its link vanished in the
 * meantime, so there is nothing left to follow.
 */
export type LinkUpdateOutcome = 'updated' | 'unchanged' | 'missing' | 'tooLarge' | 'gone';

export interface EnvFileLinkDeps {
  listLinked: () => Promise<LinkedEnvFile[]>;
  /** Reads the file into its saved copy. Throws VaultLockedError while the vault is locked. */
  updateFromDisk: (file: LinkedEnvFile) => Promise<LinkUpdateOutcome>;
  stat: (path: string) => Promise<FileSignature | null>;
  /** `onChange` runs once a change to the file has settled. */
  watch: (path: string, onChange: () => void) => { close: () => void };
  onVaultUnlocked: (listener: () => void) => () => void;
  loadMarks: () => Promise<Record<string, FileSignature>>;
  saveMarks: (marks: Record<string, FileSignature>) => Promise<void>;
  /** Undefined clears it, when the link is gone. */
  setState: (fileId: string, state: EnvFileLinkState | undefined) => void;
  /** The project's environments changed, so an open Environments tab should refetch. */
  notify: (projectId: string) => void;
}

export interface EnvFileLinkManager {
  /** Brings the watchers in line with the links saved now. Safe to call as often as needed. */
  reconcile: () => Promise<void>;
  /** Looks at one linked file again right away, after Runova wrote it itself. */
  recheck: (fileId: string) => Promise<void>;
  /** Resolves once every queued check is done. */
  idle: () => Promise<void>;
  stop: () => void;
}

interface Watched {
  file: LinkedEnvFile;
  close: () => void;
}

function sameSignature(a: FileSignature | undefined, b: FileSignature): boolean {
  return a !== undefined && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export function createEnvFileLinkManager(deps: EnvFileLinkDeps): EnvFileLinkManager {
  const watched = new Map<string, Watched>();
  const states = new Map<string, EnvFileLinkState>();
  /** Files that changed while the vault was locked. */
  const owed = new Set<string>();
  let marks: Record<string, FileSignature> | null = null;
  let stopped = false;
  // Checks and reconciles run one at a time, so two never race over the same file or the marks.
  let queue: Promise<void> = Promise.resolve();

  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = queue.then(work).catch(() => undefined);
    queue = next;
    return next;
  }

  async function loadedMarks(): Promise<Record<string, FileSignature>> {
    marks ??= { ...(await deps.loadMarks().catch(() => ({}))) };
    return marks;
  }

  async function setMark(fileId: string, signature: FileSignature | undefined): Promise<void> {
    const current = await loadedMarks();
    if (signature) current[fileId] = signature;
    else if (fileId in current) delete current[fileId];
    else return;
    await deps.saveMarks({ ...current }).catch(() => undefined);
  }

  /** Returns true when the state actually changed. */
  function setState(fileId: string, state: EnvFileLinkState | undefined): boolean {
    if (states.get(fileId) === state) return false;
    if (state) states.set(fileId, state);
    else states.delete(fileId);
    deps.setState(fileId, state);
    return true;
  }

  async function forget(fileId: string): Promise<void> {
    watched.get(fileId)?.close();
    watched.delete(fileId);
    owed.delete(fileId);
    setState(fileId, undefined);
    await setMark(fileId, undefined);
  }

  async function check(file: LinkedEnvFile): Promise<void> {
    if (stopped || watched.get(file.fileId)?.file !== file || !file.path) return;
    const signature = await deps.stat(file.path);
    let changed = false;
    let state: EnvFileLinkState;

    if (signature === null) {
      state = 'missing';
    } else if (signature.size > MAX_ENV_FILE_BYTES) {
      state = 'tooLarge';
    } else if (sameSignature((await loadedMarks())[file.fileId], signature)) {
      state = 'watching';
    } else {
      try {
        const outcome = await deps.updateFromDisk(file);
        if (outcome === 'gone') {
          await forget(file.fileId);
          deps.notify(file.projectId);
          return;
        }
        owed.delete(file.fileId);
        changed = outcome === 'updated';
        state =
          outcome === 'missing' ? 'missing' : outcome === 'tooLarge' ? 'tooLarge' : 'watching';
        if (state === 'watching') await setMark(file.fileId, signature);
      } catch (error) {
        if (error instanceof VaultLockedError) {
          owed.add(file.fileId);
          state = 'waitingForUnlock';
        } else {
          state = 'error';
        }
      }
    }

    if (setState(file.fileId, state) || changed) deps.notify(file.projectId);
  }

  async function reconcileNow(): Promise<void> {
    if (stopped) return;
    const files = await deps.listLinked();
    const wanted = new Map(files.map((file) => [file.fileId, file]));

    for (const fileId of [...watched.keys()]) {
      if (!wanted.has(fileId)) await forget(fileId);
    }
    // A mark can outlive its link when the app closed in between; drop those too.
    for (const fileId of Object.keys(await loadedMarks())) {
      if (!wanted.has(fileId)) await setMark(fileId, undefined);
    }

    const fresh: LinkedEnvFile[] = [];
    for (const file of files) {
      const current = watched.get(file.fileId);
      if (current && current.file.path === file.path) {
        // Same file in the same place; keep the watcher, but take the latest ids.
        current.file = file;
        continue;
      }
      current?.close();
      if (current) await setMark(file.fileId, undefined);
      const entry: Watched = { file, close: () => undefined };
      watched.set(file.fileId, entry);
      if (!file.path) {
        if (setState(file.fileId, 'noFolder')) deps.notify(file.projectId);
        continue;
      }
      const handle = deps.watch(file.path, () => {
        void enqueue(() => check(entry.file));
      });
      entry.close = handle.close;
      fresh.push(file);
    }
    for (const file of fresh) await check(watched.get(file.fileId)?.file ?? file);
  }

  const stopUnlockListener = deps.onVaultUnlocked(() => {
    for (const fileId of owed) {
      const entry = watched.get(fileId);
      if (entry) void enqueue(() => check(entry.file));
    }
  });

  return {
    reconcile: () => enqueue(reconcileNow),
    recheck: (fileId) => {
      const entry = watched.get(fileId);
      return entry ? enqueue(() => check(entry.file)) : Promise.resolve();
    },
    idle: async () => {
      // A check can queue another (an unlock, a watcher firing), so wait until it settles.
      let seen: Promise<void>;
      do {
        seen = queue;
        await seen;
      } while (seen !== queue);
    },
    stop: () => {
      stopped = true;
      stopUnlockListener();
      for (const entry of watched.values()) entry.close();
      watched.clear();
    },
  };
}
