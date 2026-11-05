import type {
  CleanResult,
  ProviderScan,
  SystemCleanEvent,
  SystemCleanupScan,
  SystemScanEvent,
} from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { electronState, fakeWebContents } from '../../test/main/electronMock';
import { expectChannelsCovered, invoke, invokeFrom, loadIpc } from '../../test/main/ipcHarness';
import type { SystemCleanupService } from '../systemCleanup/runtime';

/**
 * The window can ask this to delete tens of gigabytes, so these cover who may ask, that it can
 * only ever name things by id, and that the progress it is told about reaches the right window.
 */

expectChannelsCovered(IPC.systemCleanup, [
  IPC.systemCleanup.onScanEvent,
  IPC.systemCleanup.onCleanEvent,
]);

const provider: ProviderScan = {
  id: 'nuget',
  label: 'NuGet',
  tagline: '.NET packages',
  kind: 'versioned',
  status: 'ready',
  root: '/cache',
  bytes: 10,
  files: 1,
  sharedBytes: 0,
  unreadable: 0,
  items: [],
  clearCommand: null,
  tidyCommand: null,
  afterClearing: '',
};

const scan: SystemCleanupScan = {
  scanId: 's1',
  startedAt: 1,
  finishedAt: 2,
  cancelled: false,
  providers: [provider],
  volumes: [],
};

const result: CleanResult = {
  providerId: 'nuget',
  removed: 1,
  freedBytes: 10,
  failed: [],
  skipped: [],
  cancelled: false,
  provider,
};

interface Rig {
  service: SystemCleanupService;
  scan: ReturnType<typeof vi.fn>;
  clean: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  rootOf: ReturnType<typeof vi.fn>;
}

function rig(root: string | null = '/cache'): Rig {
  const scanFn = vi.fn(async (request: { onEvent: (event: SystemScanEvent) => void }) => {
    request.onEvent({ type: 'finished', requestId: 'r1', cancelled: false });
    return scan;
  });
  const cleanFn = vi.fn(async (request: { onEvent: (event: SystemCleanEvent) => void }) => {
    request.onEvent({ type: 'finished', requestId: 'c1', providerId: 'nuget', cancelled: false });
    return result;
  });
  const cancelFn = vi.fn((id: string) => id === 'r1');
  const rootOfFn = vi.fn(async () => root);
  return {
    scan: scanFn,
    clean: cleanFn,
    cancel: cancelFn,
    rootOf: rootOfFn,
    service: {
      status: () => ({ enabled: true }),
      scan: scanFn,
      clean: cleanFn,
      cancel: cancelFn,
      rootOf: rootOfFn,
      current: () => scan,
      whenTidy: async () => undefined,
    },
  };
}

async function register(r: Rig, options: { guard?: () => boolean } = {}): Promise<void> {
  await loadIpc(
    () => import('./systemCleanup'),
    (module) => module.registerSystemCleanupHandlers({ service: r.service, ...options }),
  );
}

beforeEach(() => {
  electronState.openedPaths.length = 0;
});

describe('status', () => {
  it('says whether Disk Cleanup is on', async () => {
    await register(rig());
    expect(await invoke(IPC.systemCleanup.status)).toEqual({ enabled: true });
  });
});

describe('scan', () => {
  it('scans everything, and tells the calling window how it is going', async () => {
    const r = rig();
    await register(r);
    const sender = fakeWebContents();
    const answer = await invokeFrom<SystemCleanupScan>(sender, IPC.systemCleanup.scan, 'r1');
    expect(answer).toEqual(scan);
    expect(r.scan.mock.calls[0]?.[0]).toMatchObject({ requestId: 'r1', providerIds: undefined });
    expect(sender.sentOn(IPC.systemCleanup.onScanEvent)).toEqual([
      [{ type: 'finished', requestId: 'r1', cancelled: false }],
    ]);
  });

  it('scans just the caches it is asked for', async () => {
    const r = rig();
    await register(r);
    await invoke(IPC.systemCleanup.scan, 'r1', ['nuget', 'bun']);
    expect(r.scan.mock.calls[0]?.[0]).toMatchObject({ providerIds: ['nuget', 'bun'] });
  });

  it('does not flood the window with progress, but passes everything else on', async () => {
    const r = rig();
    r.scan.mockImplementation(async (request: { onEvent: (event: SystemScanEvent) => void }) => {
      request.onEvent({ type: 'started', requestId: 'r1', scanId: 's1', providers: [] });
      for (let bytes = 1; bytes <= 50; bytes += 1) {
        request.onEvent({
          type: 'progress',
          requestId: 'r1',
          providerId: 'nuget',
          bytes,
          files: bytes,
        });
      }
      request.onEvent({ type: 'provider-done', requestId: 'r1', provider });
      request.onEvent({ type: 'finished', requestId: 'r1', cancelled: false });
      return scan;
    });
    await register(r);
    const sender = fakeWebContents();
    await invokeFrom(sender, IPC.systemCleanup.scan, 'r1');
    const types = sender
      .sentOn(IPC.systemCleanup.onScanEvent)
      .map(([event]) => (event as SystemScanEvent).type);
    expect(types.filter((type) => type === 'progress').length).toBeLessThan(5);
    expect(types).toContain('started');
    expect(types).toContain('provider-done');
    expect(types.at(-1)).toBe('finished');
  });

  it.each([
    ['an empty request id', ''],
    ['a request id that is not text', 7],
    ['a request id that is far too long', 'x'.repeat(500)],
  ])('refuses %s', async (_what, requestId) => {
    await register(rig());
    await expect(invoke(IPC.systemCleanup.scan, requestId)).rejects.toThrow(/not valid/i);
  });

  it.each([
    ['a cache that does not exist', ['nope']],
    ['a path instead of a cache', ['C:\\Users\\me']],
    ['something that is not a list', 'nuget'],
    ['a list that is far too long', Array.from({ length: 100 }, () => 'nuget')],
  ])('refuses %s', async (_what, providerIds) => {
    await register(rig());
    await expect(invoke(IPC.systemCleanup.scan, 'r1', providerIds)).rejects.toThrow(/not valid/i);
  });
});

describe('cancel', () => {
  it('stops a run by its request id', async () => {
    const r = rig();
    await register(r);
    expect(await invoke(IPC.systemCleanup.cancel, 'r1')).toBe(true);
    expect(await invoke(IPC.systemCleanup.cancel, 'other')).toBe(false);
  });

  it('refuses a request id that is not valid', async () => {
    await register(rig());
    await expect(invoke(IPC.systemCleanup.cancel, '')).rejects.toThrow(/not valid/i);
  });
});

describe('clean', () => {
  it('passes the choice on, and tells the calling window how it is going', async () => {
    const r = rig();
    await register(r);
    const sender = fakeWebContents();
    const answer = await invokeFrom<CleanResult>(sender, IPC.systemCleanup.clean, 'c1', 's1', {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 2,
    });
    expect(answer).toEqual(result);
    expect(r.clean.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'c1',
      scanId: 's1',
      selection: { mode: 'old-versions', providerId: 'nuget', keep: 2 },
    });
    expect(sender.sentOn(IPC.systemCleanup.onCleanEvent)).toHaveLength(1);
  });

  it.each([
    { mode: 'old-versions', providerId: 'nuget', keep: 1 },
    { mode: 'old-versions', providerId: 'bun', keep: 9 },
    { mode: 'everything', providerId: 'nuget' },
    { mode: 'items', providerId: 'nuget', itemIds: ['a', 'b1'] },
    { mode: 'tidy', providerId: 'pnpm' },
    { mode: 'clear-command', providerId: 'npm' },
  ])('accepts the choice %j', async (selection) => {
    const r = rig();
    await register(r);
    await invoke(IPC.systemCleanup.clean, 'c1', 's1', selection);
    expect(r.clean).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a mode it does not know', { mode: 'wipe-disk', providerId: 'nuget' }],
    ['no mode at all', { providerId: 'nuget' }],
    ['a cache it does not know', { mode: 'everything', providerId: 'documents' }],
    ['keeping none', { mode: 'old-versions', providerId: 'nuget', keep: 0 }],
    ['keeping too many', { mode: 'old-versions', providerId: 'nuget', keep: 10 }],
    ['keeping part of one', { mode: 'old-versions', providerId: 'nuget', keep: 1.5 }],
    ['keeping, with no number', { mode: 'old-versions', providerId: 'nuget' }],
    ['no items', { mode: 'items', providerId: 'nuget', itemIds: [] }],
    ['items that are not text', { mode: 'items', providerId: 'nuget', itemIds: [1, 2] }],
    [
      'an item id that is a whole path',
      { mode: 'items', providerId: 'nuget', itemIds: ['x'.repeat(100)] },
    ],
    [
      'a path smuggled in beside a valid choice',
      { mode: 'everything', providerId: 'nuget', path: 'C:\\Windows' },
    ],
    [
      'a path smuggled into a list of items',
      { mode: 'items', providerId: 'nuget', itemIds: ['a'], paths: ['C:\\'] },
    ],
    ['a choice that is not an object', 'everything'],
    ['nothing', null],
  ])('refuses %s', async (_what, selection) => {
    const r = rig();
    await register(r);
    await expect(invoke(IPC.systemCleanup.clean, 'c1', 's1', selection)).rejects.toThrow(
      /not valid/i,
    );
    expect(r.clean).not.toHaveBeenCalled();
  });

  it('refuses a scan id or request id that is not valid', async () => {
    const r = rig();
    await register(r);
    const choice = { mode: 'everything', providerId: 'nuget' };
    await expect(invoke(IPC.systemCleanup.clean, '', 's1', choice)).rejects.toThrow(/not valid/i);
    await expect(invoke(IPC.systemCleanup.clean, 'c1', '', choice)).rejects.toThrow(/not valid/i);
    await expect(invoke(IPC.systemCleanup.clean, 'c1', 5, choice)).rejects.toThrow(/not valid/i);
    expect(r.clean).not.toHaveBeenCalled();
  });
});

describe('reveal', () => {
  it('opens the folder a cache lives in', async () => {
    await register(rig('/cache/nuget'));
    expect(await invoke(IPC.systemCleanup.reveal, 'nuget')).toBe(true);
    expect(electronState.openedPaths).toEqual(['/cache/nuget']);
  });

  it('says no when the cache is not on this machine', async () => {
    await register(rig(null));
    expect(await invoke(IPC.systemCleanup.reveal, 'bun')).toBe(false);
    expect(electronState.openedPaths).toEqual([]);
  });

  it('only opens a cache it knows, never a path it is handed', async () => {
    const r = rig();
    await register(r);
    await expect(invoke(IPC.systemCleanup.reveal, 'C:\\Users\\me')).rejects.toThrow(/not valid/i);
    expect(r.rootOf).not.toHaveBeenCalled();
    expect(electronState.openedPaths).toEqual([]);
  });
});

describe('who may ask', () => {
  it('answers the windows the guard allows, and no others', async () => {
    const r = rig();
    await register(r, { guard: () => false });
    const choice = { mode: 'everything', providerId: 'nuget' };
    for (const call of [
      () => invoke(IPC.systemCleanup.status),
      () => invoke(IPC.systemCleanup.scan, 'r1'),
      () => invoke(IPC.systemCleanup.cancel, 'r1'),
      () => invoke(IPC.systemCleanup.clean, 'c1', 's1', choice),
      () => invoke(IPC.systemCleanup.reveal, 'nuget'),
    ]) {
      await expect(call()).rejects.toThrow(/main window/i);
    }
    expect(r.scan).not.toHaveBeenCalled();
    expect(r.clean).not.toHaveBeenCalled();
    expect(r.rootOf).not.toHaveBeenCalled();
  });
});
