import { MAX_ENV_FILE_BYTES } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type { EnvFileLinkState } from '../../shared/apiTypes';
import type { FileSignature } from '../fs/openFileWatcher';
import { VaultLockedError } from '../ssh/vaultErrors';
import {
  createEnvFileLinkManager,
  type EnvFileLinkDeps,
  type LinkedEnvFile,
  type LinkUpdateOutcome,
} from './fileLinks';

/**
 * The link manager keeps an env file saved in Runova in step with a file in the project folder.
 * Everything it touches (the watcher, the disk, the vault, the store) is faked here, so each test
 * drives one change by hand and reads what the manager made of it.
 */

const linked = (overrides: Partial<LinkedEnvFile> = {}): LinkedEnvFile => ({
  projectId: 'p1',
  environmentId: 'e1',
  fileId: 'f1',
  path: '/project/.env.prod',
  ...overrides,
});

function setup(initial: LinkedEnvFile[] = [linked()]) {
  let files = initial;
  const disk = new Map<string, FileSignature | null>([
    ['/project/.env.prod', { mtimeMs: 1, size: 10 }],
  ]);
  const watchers = new Map<string, { onChange: () => void; closed: boolean }>();
  const states = new Map<string, EnvFileLinkState>();
  const unlockListeners: (() => void)[] = [];
  let marks: Record<string, FileSignature> = {};
  const outcomes: LinkUpdateOutcome[] = [];
  let locked = false;

  const deps: EnvFileLinkDeps = {
    listLinked: async () => files,
    stat: async (path) => disk.get(path) ?? null,
    updateFromDisk: vi.fn(async () => {
      if (locked) throw new VaultLockedError();
      return outcomes.shift() ?? 'updated';
    }),
    watch: vi.fn((path: string, onChange: () => void) => {
      const watcher = { onChange, closed: false };
      watchers.set(path, watcher);
      return { close: () => (watcher.closed = true) };
    }),
    onVaultUnlocked: (listener) => {
      unlockListeners.push(listener);
      return () => undefined;
    },
    loadMarks: async () => marks,
    saveMarks: vi.fn(async (next: Record<string, FileSignature>) => {
      marks = { ...next };
    }),
    setState: (fileId, state) => {
      if (state) states.set(fileId, state);
      else states.delete(fileId);
    },
    notify: vi.fn(),
  };
  const manager = createEnvFileLinkManager(deps);
  return {
    manager,
    deps,
    disk,
    watchers,
    states,
    outcomes,
    get marks() {
      return marks;
    },
    setMarks: (next: Record<string, FileSignature>) => {
      marks = next;
    },
    setFiles: (next: LinkedEnvFile[]) => {
      files = next;
    },
    lock: (value: boolean) => {
      locked = value;
    },
    unlock: () => {
      locked = false;
      for (const listener of unlockListeners) listener();
    },
    /** A change on disk, as the watcher reports it once its debounce settles. */
    async change(path: string, signature: FileSignature | null) {
      disk.set(path, signature);
      watchers.get(path)?.onChange();
      await manager.idle();
    },
  };
}

describe('the env file link manager', () => {
  it('watches every linked file and picks up a change made while the app was closed', async () => {
    const t = setup();
    await t.manager.reconcile();

    expect(t.deps.watch).toHaveBeenCalledWith('/project/.env.prod', expect.any(Function));
    // No mark yet, so the file counts as changed: the item takes what is on disk.
    expect(t.deps.updateFromDisk).toHaveBeenCalledWith(linked());
    expect(t.states.get('f1')).toBe('watching');
    expect(t.marks).toEqual({ f1: { mtimeMs: 1, size: 10 } });
    expect(t.deps.notify).toHaveBeenCalledWith('p1');
  });

  it('leaves the item alone at start when the file is as it was last seen', async () => {
    const t = setup();
    t.setMarks({ f1: { mtimeMs: 1, size: 10 } });
    await t.manager.reconcile();

    // Another computer may have synced newer contents in; an untouched file must not undo them.
    expect(t.deps.updateFromDisk).not.toHaveBeenCalled();
    expect(t.states.get('f1')).toBe('watching');
  });

  it('saves a new version when the file changes, and only says so when something changed', async () => {
    const t = setup();
    await t.manager.reconcile();
    vi.mocked(t.deps.notify).mockClear();

    await t.change('/project/.env.prod', { mtimeMs: 2, size: 12 });
    expect(t.deps.updateFromDisk).toHaveBeenCalledTimes(2);
    expect(t.deps.notify).toHaveBeenCalledTimes(1);
    expect(t.marks.f1).toEqual({ mtimeMs: 2, size: 12 });

    // Runova's own write coming back through the watcher: same contents, nothing to tell.
    t.outcomes.push('unchanged');
    await t.change('/project/.env.prod', { mtimeMs: 3, size: 12 });
    expect(t.deps.notify).toHaveBeenCalledTimes(1);
    expect(t.marks.f1).toEqual({ mtimeMs: 3, size: 12 });
  });

  it('keeps the saved contents when the file goes missing, and catches up when it is back', async () => {
    const t = setup();
    await t.manager.reconcile();

    await t.change('/project/.env.prod', null);
    expect(t.states.get('f1')).toBe('missing');
    expect(t.deps.updateFromDisk).toHaveBeenCalledTimes(1);

    await t.change('/project/.env.prod', { mtimeMs: 5, size: 3 });
    expect(t.states.get('f1')).toBe('watching');
    expect(t.deps.updateFromDisk).toHaveBeenCalledTimes(2);
  });

  it('skips a file that grew past the size limit', async () => {
    const t = setup();
    await t.manager.reconcile();

    await t.change('/project/.env.prod', { mtimeMs: 2, size: MAX_ENV_FILE_BYTES + 1 });
    expect(t.states.get('f1')).toBe('tooLarge');
    expect(t.deps.updateFromDisk).toHaveBeenCalledTimes(1);
  });

  it('waits for the vault to open, then saves the change', async () => {
    const t = setup();
    t.lock(true);
    await t.manager.reconcile();
    expect(t.states.get('f1')).toBe('waitingForUnlock');
    // Not marked, so the change is still owed.
    expect(t.marks).toEqual({});

    t.unlock();
    await t.manager.idle();
    expect(t.states.get('f1')).toBe('watching');
    expect(t.marks.f1).toEqual({ mtimeMs: 1, size: 10 });
  });

  it('shows an error state when an update fails for another reason', async () => {
    const t = setup();
    vi.mocked(t.deps.updateFromDisk).mockRejectedValueOnce(new Error('EACCES'));
    await t.manager.reconcile();
    expect(t.states.get('f1')).toBe('error');
  });

  it('follows links as they are added, moved and removed', async () => {
    const t = setup([]);
    await t.manager.reconcile();
    expect(t.watchers.size).toBe(0);

    t.setFiles([linked()]);
    await t.manager.reconcile();
    expect(t.watchers.get('/project/.env.prod')?.closed).toBe(false);

    // A second reconcile with nothing new neither rewatches nor rechecks.
    await t.manager.reconcile();
    expect(t.deps.watch).toHaveBeenCalledTimes(1);
    expect(t.deps.updateFromDisk).toHaveBeenCalledTimes(1);

    t.disk.set('/project/apps/api/.env', { mtimeMs: 1, size: 4 });
    t.setFiles([linked({ path: '/project/apps/api/.env' })]);
    await t.manager.reconcile();
    expect(t.watchers.get('/project/.env.prod')?.closed).toBe(true);
    expect(t.watchers.get('/project/apps/api/.env')?.closed).toBe(false);

    t.setFiles([]);
    await t.manager.reconcile();
    expect(t.watchers.get('/project/apps/api/.env')?.closed).toBe(true);
    expect(t.states.has('f1')).toBe(false);
    expect(t.marks).toEqual({});
  });

  it('says so when the project has no folder on this computer', async () => {
    const t = setup([linked({ path: null })]);
    await t.manager.reconcile();
    expect(t.deps.watch).not.toHaveBeenCalled();
    expect(t.states.get('f1')).toBe('noFolder');
  });

  it('neither watches nor reads a link that still needs confirming, and follows it once it is', async () => {
    const t = setup([linked({ path: null, needsConfirmation: true })]);
    await t.manager.reconcile();
    expect(t.deps.watch).not.toHaveBeenCalled();
    expect(t.deps.updateFromDisk).not.toHaveBeenCalled();
    expect(t.states.get('f1')).toBe('needsConfirmation');

    t.setFiles([linked()]);
    await t.manager.reconcile();
    expect(t.deps.watch).toHaveBeenCalledWith('/project/.env.prod', expect.any(Function));
    expect(t.states.get('f1')).toBe('watching');
  });

  it('drops a link whose item vanished between the list and the update', async () => {
    const t = setup();
    t.outcomes.push('gone');
    await t.manager.reconcile();
    expect(t.states.has('f1')).toBe(false);
    expect(t.marks).toEqual({});
  });

  it('stops every watcher', async () => {
    const t = setup();
    await t.manager.reconcile();
    t.manager.stop();
    expect(t.watchers.get('/project/.env.prod')?.closed).toBe(true);
  });
});
