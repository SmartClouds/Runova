import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type {
  CleanupRemoveEvent,
  CleanupRemoveResult,
  CleanupScanEvent,
  ProjectCleanupScan,
} from '../../shared/projectCleanupTypes';
import { fakeWebContents } from '../../test/main/electronMock';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { expectChannelsCovered, invoke, invokeFrom, loadIpc } from '../../test/main/ipcHarness';
import type { CleanupDeps } from '../projectCleanup/service';

/**
 * The window can ask this to delete folders, so these cover who may ask, what it may ask for, and
 * that a scan and a removal never run over each other in one project.
 */

const state = vi.hoisted(() => ({ deps: null as unknown }));

vi.mock('../projectCleanup/deps', () => ({
  createCleanupDeps: () => state.deps,
}));

expectChannelsCovered(IPC.projectCleanup, [
  IPC.projectCleanup.onScanEvent,
  IPC.projectCleanup.onRemoveEvent,
]);

function shop(): string {
  return writeTree(tempDir(), {
    'package.json': '{}',
    'src/index.ts': 'export {};',
    'node_modules/dep/index.js': 'x'.repeat(500),
    'dist/main.js': 'x'.repeat(100),
  });
}

interface Rig {
  root: string;
  deps: CleanupDeps;
  /** Holds the scan open until `release()` is called. */
  hold(): void;
  release(): void;
}

function rig(root = shop()): Rig {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const deps: CleanupDeps = {
    getProject: async (id) =>
      id === 'p1' || id === 'p2' ? { id, name: 'Shop', folderPath: root } : null,
    worktrees: async () => {
      if (gate) await gate;
      return [];
    },
    locks: async () => [],
    studio: {
      usage: async () => [],
      clear: async () => ({ freedBytes: 0, cleared: [], skipped: [] }),
    },
  };
  return {
    root,
    deps,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
    },
  };
}

async function register(r: Rig, options: { guard?: () => boolean } = {}): Promise<void> {
  state.deps = r.deps;
  await loadIpc(
    () => import('./projectCleanup'),
    (module) => module.registerProjectCleanupHandlers(options),
  );
}

beforeEach(() => {
  state.deps = null;
});

describe('projectCleanup:scan', () => {
  it('returns what the project holds', async () => {
    const r = rig();
    await register(r);
    const scan = await invoke<ProjectCleanupScan>(IPC.projectCleanup.scan, 'p1', 'req-1');
    expect(scan.projectId).toBe('p1');
    expect(scan.locations[0]?.candidates.map((c) => c.relPath)).toEqual(['node_modules', 'dist']);
  });

  it('streams the scan to the window that asked, tagged with the request', async () => {
    const r = rig();
    await register(r);
    const sender = fakeWebContents();
    await invokeFrom(sender, IPC.projectCleanup.scan, 'p1', 'req-2');
    const events = sender
      .sentOn(IPC.projectCleanup.onScanEvent)
      .map(([event]) => event as CleanupScanEvent);
    expect(events.every((event) => event.requestId === 'req-2')).toBe(true);
    expect(events[0]?.type).toBe('location');
    expect(events.filter((e) => e.type === 'candidate')).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('studio');
  });

  it('refuses a project that is gone', async () => {
    await register(rig());
    await expect(invoke(IPC.projectCleanup.scan, 'nope', 'req-3')).rejects.toThrow(
      'That project no longer exists.',
    );
  });

  it('can be cancelled by its request id', async () => {
    const r = rig();
    r.hold();
    await register(r);
    const running = invoke(IPC.projectCleanup.scan, 'p1', 'req-4');
    await vi.waitFor(async () => {
      expect(await invoke<boolean>(IPC.projectCleanup.cancel, 'req-4')).toBe(true);
    });
    r.release();
    await expect(running).rejects.toThrow(/cancelled/i);
  });

  it('says so when there is nothing to cancel', async () => {
    await register(rig());
    expect(await invoke<boolean>(IPC.projectCleanup.cancel, 'never-started')).toBe(false);
  });

  it('works on one project at a time, but lets two projects scan together', async () => {
    const r = rig();
    r.hold();
    await register(r);
    const first = invoke(IPC.projectCleanup.scan, 'p1', 'a');
    await vi.waitFor(async () => {
      await expect(invoke(IPC.projectCleanup.scan, 'p1', 'b')).rejects.toThrow(/already/i);
    });
    const other = invoke(IPC.projectCleanup.scan, 'p2', 'c');
    r.release();
    await expect(first).resolves.toBeDefined();
    await expect(other).resolves.toBeDefined();
  });

  it('is free again once a scan has finished, even a failed one', async () => {
    await register(rig());
    await expect(invoke(IPC.projectCleanup.scan, 'nope', 'x1')).rejects.toThrow();
    await expect(invoke(IPC.projectCleanup.scan, 'p1', 'x2')).resolves.toBeDefined();
    await expect(invoke(IPC.projectCleanup.scan, 'p1', 'x3')).resolves.toBeDefined();
  });

  it.each([
    ['a project id that is not text', [7, 'req']],
    ['an empty project id', ['', 'req']],
    ['no request id', ['p1']],
    ['an empty request id', ['p1', '']],
    ['a request id far too long', ['p1', 'x'.repeat(500)]],
  ])('rejects %s', async (_label, args) => {
    await register(rig());
    await expect(invoke(IPC.projectCleanup.scan, ...args)).rejects.toThrow();
  });
});

describe('projectCleanup:remove', () => {
  it('deletes what it is asked to and reports each step to the window', async () => {
    const r = rig();
    await register(r);
    await invoke(IPC.projectCleanup.scan, 'p1', 's1');
    const sender = fakeWebContents();
    const result = await invokeFrom<CleanupRemoveResult>(
      sender,
      IPC.projectCleanup.remove,
      'p1',
      'rm-1',
      [{ kind: 'folder', locationId: 'main', relPath: 'dist' }],
    );
    expect(result).toEqual({ freedBytes: 100, removed: ['main:dist'], failed: [] });
    expect(existsSync(join(r.root, 'dist'))).toBe(false);
    expect(existsSync(join(r.root, 'src', 'index.ts'))).toBe(true);
    const events = sender
      .sentOn(IPC.projectCleanup.onRemoveEvent)
      .map(([event]) => event as CleanupRemoveEvent);
    expect(events.map((e) => e.status)).toEqual(['removing', 'done']);
    expect(events.every((e) => e.requestId === 'rm-1')).toBe(true);
  });

  it('refuses to touch anything the scan would not have offered', async () => {
    const r = rig();
    await register(r);
    const result = await invoke<CleanupRemoveResult>(IPC.projectCleanup.remove, 'p1', 'rm-2', [
      { kind: 'folder', locationId: 'main', relPath: 'src' },
      { kind: 'folder', locationId: 'main', relPath: '../outside' },
      { kind: 'folder', locationId: 'main', relPath: '.git' },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(3);
    expect(existsSync(join(r.root, 'src', 'index.ts'))).toBe(true);
  });

  it('will not delete in a project while a scan of it is running', async () => {
    const r = rig();
    r.hold();
    await register(r);
    const scanning = invoke(IPC.projectCleanup.scan, 'p1', 'busy');
    await vi.waitFor(async () => {
      await expect(
        invoke(IPC.projectCleanup.remove, 'p1', 'rm-3', [
          { kind: 'folder', locationId: 'main', relPath: 'dist' },
        ]),
      ).rejects.toThrow(/already/i);
    });
    r.release();
    await scanning;
    expect(existsSync(join(r.root, 'dist', 'main.js'))).toBe(true);
  });

  it.each([
    ['items that are not a list', ['p1', 'r', 'dist']],
    ['no items at all', ['p1', 'r', []]],
    ['an item of an unknown kind', ['p1', 'r', [{ kind: 'file', path: 'x' }]]],
    [
      'a folder item with a path that is not text',
      ['p1', 'r', [{ kind: 'folder', locationId: 'main', relPath: 7 }]],
    ],
    ['a folder item with no location', ['p1', 'r', [{ kind: 'folder', relPath: 'dist' }]]],
    ['a studio item with no video', ['p1', 'r', [{ kind: 'studio' }]]],
    [
      'far too many items',
      ['p1', 'r', Array.from({ length: 501 }, () => ({ kind: 'studio', videoId: 'v' }))],
    ],
  ])('rejects %s', async (_label, args) => {
    await register(rig());
    await expect(invoke(IPC.projectCleanup.remove, ...args)).rejects.toThrow();
  });
});

describe('who may ask', () => {
  it('answers only the windows the guard lets through', async () => {
    await register(rig(), { guard: () => false });
    await expect(invoke(IPC.projectCleanup.scan, 'p1', 'g1')).rejects.toThrow(/main window/);
    await expect(
      invoke(IPC.projectCleanup.remove, 'p1', 'g2', [{ kind: 'studio', videoId: 'v' }]),
    ).rejects.toThrow(/main window/);
    await expect(invoke(IPC.projectCleanup.cancel, 'g3')).rejects.toThrow(/main window/);
  });
});
