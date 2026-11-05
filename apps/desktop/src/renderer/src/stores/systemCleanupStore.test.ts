import type {
  CleanResult,
  ProviderScan,
  ScanItem,
  SystemCleanEvent,
  SystemCleanupScan,
  SystemScanEvent,
} from '@runova/core';
import { describe, expect, it } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { useSystemCleanupStore } from './systemCleanupStore';

function item(group: string, version: string, bytes: number): ScanItem {
  return {
    id: `${group}-${version}`,
    group,
    groupLabel: group,
    version,
    bytes,
    sharedBytes: 0,
    files: 2,
    newestMs: 1,
  };
}

function provider(id: ProviderScan['id'], overrides: Partial<ProviderScan> = {}): ProviderScan {
  return {
    id,
    label: id.toUpperCase(),
    tagline: '',
    kind: 'versioned',
    status: 'ready',
    root: `/c/${id}`,
    bytes: 300,
    files: 6,
    sharedBytes: 0,
    unreadable: 0,
    items: [item('a', '1.0.0', 100), item('a', '2.0.0', 200)],
    clearCommand: null,
    tidyCommand: null,
    afterClearing: '',
    ...overrides,
  };
}

function scanOf(
  providers: ProviderScan[],
  extra: Partial<SystemCleanupScan> = {},
): SystemCleanupScan {
  return {
    scanId: 's1',
    startedAt: 10,
    finishedAt: 20,
    cancelled: false,
    providers,
    volumes: [],
    ...extra,
  };
}

function gate<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const store = () => useSystemCleanupStore.getState();

describe('checkAvailability', () => {
  it('asks whether Disk Cleanup is on', async () => {
    installRunovaBridge({
      'systemCleanup.status': async () => ({ enabled: false, reason: 'Off.' }),
    });
    await store().checkAvailability();
    expect(store().availability).toEqual({ enabled: false, reason: 'Off.' });
  });

  it('treats an unanswered question as on', async () => {
    installRunovaBridge({ 'systemCleanup.status': async () => undefined });
    await store().checkAvailability();
    expect(store().availability).toEqual({ enabled: true });
  });
});

describe('scan', () => {
  it('keeps what it found, and remembers a summary of each cache read properly', async () => {
    installRunovaBridge({
      'systemCleanup.scan': async () =>
        scanOf([provider('nuget'), provider('bun', { status: 'missing' })]),
    });
    await store().startScan();
    expect(store().scan?.scanId).toBe('s1');
    expect(store().summaries.nuget).toMatchObject({ bytes: 300, packageCount: 1, scannedAt: 20 });
    expect(store().summaries.bun).toBeUndefined();
    expect(store().progress.running).toBe(false);
    expect(store().error).toBeNull();
  });

  it('follows a scan as it goes', async () => {
    const held = gate<SystemCleanupScan>();
    const bridge = installRunovaBridge({ 'systemCleanup.scan': () => held.promise });
    const running = store().startScan();
    const requestId = bridge.$fn('systemCleanup.scan').mock.calls[0]?.[0] as string;

    bridge.$emit('systemCleanup.onScanEvent', {
      type: 'started',
      requestId,
      scanId: 's1',
      providers: [{ id: 'nuget', label: 'NuGet' }],
    } satisfies SystemScanEvent);
    bridge.$emit('systemCleanup.onScanEvent', {
      type: 'progress',
      requestId,
      providerId: 'nuget',
      bytes: 500,
      files: 7,
    } satisfies SystemScanEvent);

    expect(store().progress.running).toBe(true);
    expect(store().progress.providers.nuget).toMatchObject({ bytes: 500, files: 7 });

    held.resolve(scanOf([provider('nuget')]));
    await running;
    expect(store().progress.running).toBe(false);
  });

  it('can read just some of the caches, and leaves the summaries of the others alone', async () => {
    const bridge = installRunovaBridge({
      'systemCleanup.scan': async () => scanOf([provider('nuget', { bytes: 111 })]),
    });
    useSystemCleanupStore.setState({
      summaries: {
        bun: {
          id: 'bun',
          label: 'Bun',
          tagline: '',
          kind: 'versioned',
          bytes: 9,
          files: 1,
          packageCount: 1,
          reclaimableBytes: 0,
          root: null,
          scannedAt: 1,
          clearLabel: null,
          tidyLabel: null,
        },
      },
    });
    await store().startScan(['nuget']);
    expect(bridge.$fn('systemCleanup.scan')).toHaveBeenCalledWith(expect.any(String), ['nuget']);
    expect(store().summaries.bun?.bytes).toBe(9);
    expect(store().summaries.nuget?.bytes).toBe(111);
  });

  it('forgets a cache that is gone from the machine, and keeps one whose reading was cut short', async () => {
    installRunovaBridge({
      'systemCleanup.scan': async () =>
        scanOf([
          provider('nuget', { status: 'missing' }),
          provider('bun', { status: 'cancelled' }),
        ]),
    });
    const remembered = (id: 'nuget' | 'bun') => ({
      id,
      label: id,
      tagline: '',
      kind: 'versioned' as const,
      bytes: 5,
      files: 1,
      packageCount: 1,
      reclaimableBytes: 0,
      root: null,
      scannedAt: 1,
      clearLabel: null,
      tidyLabel: null,
    });
    useSystemCleanupStore.setState({
      summaries: { nuget: remembered('nuget'), bun: remembered('bun') },
    });
    await store().startScan();
    expect(store().summaries.nuget).toBeUndefined();
    expect(store().summaries.bun).toBeDefined();
  });

  it('does not start a second scan while one is running', async () => {
    const held = gate<SystemCleanupScan>();
    const bridge = installRunovaBridge({ 'systemCleanup.scan': () => held.promise });
    const first = store().startScan();
    await store().startScan();
    expect(bridge.$fn('systemCleanup.scan')).toHaveBeenCalledTimes(1);
    held.resolve(scanOf([]));
    await first;
  });

  it('stops when cancelled, and keeps what it knew', async () => {
    const held = gate<SystemCleanupScan>();
    const bridge = installRunovaBridge({
      'systemCleanup.scan': () => held.promise,
      'systemCleanup.cancel': async () => true,
    });
    useSystemCleanupStore.setState({ scan: scanOf([provider('nuget')]) });
    const running = store().startScan();
    store().cancel();
    held.reject(new Error('cancelled'));
    await running;
    expect(bridge.$fn('systemCleanup.cancel')).toHaveBeenCalledTimes(1);
    expect(store().progress.running).toBe(false);
    expect(store().scan?.providers[0]?.id).toBe('nuget');
    expect(store().error).toBeNull();
  });

  it('keeps the message when a scan fails', async () => {
    installRunovaBridge({
      'systemCleanup.scan': async () => {
        throw new Error(
          "Error invoking remote method 'systemCleanup:scan': Error: Disk is on fire.",
        );
      },
    });
    await store().startScan();
    expect(store().error).toMatch(/disk is on fire/i);
    expect(store().progress.running).toBe(false);
  });
});

const CLEANED: CleanResult = {
  providerId: 'nuget',
  removed: 1,
  freedBytes: 100,
  failed: [],
  skipped: [],
  cancelled: false,
  provider: provider('nuget', { bytes: 200, items: [item('a', '2.0.0', 200)] }),
};

describe('clean', () => {
  async function scanned(extra: Partial<ProviderScan> = {}) {
    installRunovaBridge({ 'systemCleanup.scan': async () => scanOf([provider('nuget', extra)]) });
    await store().startScan();
  }

  it('cleans from the scan it holds, and brings the cache up to date', async () => {
    await scanned();
    const bridge = installRunovaBridge({ 'systemCleanup.clean': async () => CLEANED });
    const result = await store().startClean({ mode: 'old-versions', providerId: 'nuget', keep: 1 });
    expect(result).toEqual(CLEANED);
    expect(bridge.$fn('systemCleanup.clean')).toHaveBeenCalledWith(expect.any(String), 's1', {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 1,
    });
    expect(store().scan?.providers[0]?.bytes).toBe(200);
    expect(store().summaries.nuget?.bytes).toBe(200);
    expect(store().lastResult).toEqual(CLEANED);
    expect(store().cleaning.running).toBe(false);
  });

  it('takes the disks from the result, since removing files changes how full they are', async () => {
    await scanned();
    installRunovaBridge({
      'systemCleanup.clean': async () => ({
        ...CLEANED,
        volumes: [{ mount: 'C:', totalBytes: 1000, freeBytes: 900, cacheBytes: 10 }],
      }),
    });
    await store().startClean({ mode: 'everything', providerId: 'nuget' });
    expect(store().scan?.volumes).toEqual([
      { mount: 'C:', totalBytes: 1000, freeBytes: 900, cacheBytes: 10 },
    ]);
  });

  it('keeps the disks it had when the result carries none', async () => {
    installRunovaBridge({
      'systemCleanup.scan': async () =>
        scanOf([provider('nuget')], {
          volumes: [{ mount: 'D:', totalBytes: 500, freeBytes: 100, cacheBytes: 300 }],
        }),
    });
    await store().startScan();
    installRunovaBridge({ 'systemCleanup.clean': async () => CLEANED });
    await store().startClean({ mode: 'everything', providerId: 'nuget' });
    expect(store().scan?.volumes).toEqual([
      { mount: 'D:', totalBytes: 500, freeBytes: 100, cacheBytes: 300 },
    ]);
  });

  it('records what happened to each thing as it goes', async () => {
    await scanned();
    const held = gate<CleanResult>();
    const bridge = installRunovaBridge({ 'systemCleanup.clean': () => held.promise });
    const running = store().startClean({ mode: 'everything', providerId: 'nuget' });
    const requestId = bridge.$fn('systemCleanup.clean').mock.calls[0]?.[0] as string;

    bridge.$emit('systemCleanup.onCleanEvent', {
      type: 'started',
      requestId,
      providerId: 'nuget',
      total: 2,
      bytes: 300,
    } satisfies SystemCleanEvent);
    bridge.$emit('systemCleanup.onCleanEvent', {
      type: 'item-done',
      requestId,
      providerId: 'nuget',
      itemId: 'a-1.0.0',
      label: 'a 1.0.0',
      bytes: 100,
    } satisfies SystemCleanEvent);
    bridge.$emit('systemCleanup.onCleanEvent', {
      type: 'item-failed',
      requestId,
      providerId: 'nuget',
      itemId: 'a-2.0.0',
      label: 'a 2.0.0',
      reason: 'In use.',
    } satisfies SystemCleanEvent);

    expect(store().cleaning).toMatchObject({ running: true, processed: 2, freedBytes: 100 });
    expect(store().itemStatuses['nuget/a-1.0.0']).toEqual({ status: 'done', bytes: 100 });
    expect(store().itemStatuses['nuget/a-2.0.0']).toEqual({ status: 'failed', reason: 'In use.' });

    held.resolve({ ...CLEANED, removed: 1 });
    await running;
  });

  it('keeps a failure that the final result reports even if its event never arrived', async () => {
    await scanned();
    installRunovaBridge({
      'systemCleanup.clean': async () => ({
        ...CLEANED,
        failed: [
          { itemId: 'a-1.0.0', label: 'a 1.0.0', reason: 'In use.' },
          { itemId: null, label: 'npm cache clean --force', reason: 'It stopped with an error.' },
        ],
      }),
    });
    await store().startClean({ mode: 'everything', providerId: 'nuget' });
    expect(store().itemStatuses['nuget/a-1.0.0']).toEqual({ status: 'failed', reason: 'In use.' });
    // A failure with no item behind it (a whole command) has no row to show it on.
    expect(Object.keys(store().itemStatuses)).toEqual(['nuget/a-1.0.0']);
  });

  it('refuses to clean when nothing has been scanned', async () => {
    const bridge = installRunovaBridge({ 'systemCleanup.clean': async () => CLEANED });
    const result = await store().startClean({ mode: 'everything', providerId: 'nuget' });
    expect(result).toBeNull();
    expect(store().error).toMatch(/scan/i);
    expect(() => bridge.$fn('systemCleanup.clean')).toThrow(/has not been touched/);
  });

  it('keeps the message when a clean-up fails, and does not claim anything was freed', async () => {
    await scanned();
    installRunovaBridge({
      'systemCleanup.clean': async () => {
        throw new Error(
          "Error invoking remote method 'systemCleanup:clean': Error: That scan is out of date.",
        );
      },
    });
    expect(await store().startClean({ mode: 'everything', providerId: 'nuget' })).toBeNull();
    expect(store().error).toMatch(/out of date/i);
    expect(store().lastResult).toBeNull();
    expect(store().cleaning.running).toBe(false);
  });

  it('does not clean while a scan is running', async () => {
    const held = gate<SystemCleanupScan>();
    const bridge = installRunovaBridge({
      'systemCleanup.scan': () => held.promise,
      'systemCleanup.clean': async () => CLEANED,
    });
    useSystemCleanupStore.setState({ scan: scanOf([provider('nuget')]) });
    const scanning = store().startScan();
    expect(await store().startClean({ mode: 'everything', providerId: 'nuget' })).toBeNull();
    expect(() => bridge.$fn('systemCleanup.clean')).toThrow(/has not been touched/);
    held.resolve(scanOf([provider('nuget')]));
    await scanning;
  });

  it('forgets the statuses of an earlier clean-up of the same cache when a new one starts', async () => {
    await scanned();
    useSystemCleanupStore.setState({
      itemStatuses: {
        'nuget/old': { status: 'done', bytes: 1 },
        'bun/x': { status: 'done', bytes: 2 },
      },
    });
    installRunovaBridge({ 'systemCleanup.clean': async () => CLEANED });
    await store().startClean({ mode: 'everything', providerId: 'nuget' });
    expect(store().itemStatuses['nuget/old']).toBeUndefined();
    expect(store().itemStatuses['bun/x']).toBeDefined();
  });
});

describe('keep and the result', () => {
  it('keeps between one and three versions', () => {
    store().setKeep(2);
    expect(store().keep).toBe(2);
    store().setKeep(0);
    expect(store().keep).toBe(1);
    store().setKeep(99);
    expect(store().keep).toBe(3);
    store().setKeep(Number.NaN);
    expect(store().keep).toBe(1);
  });

  it('can put the last result away', () => {
    useSystemCleanupStore.setState({ lastResult: CLEANED, error: 'x' });
    store().dismissResult();
    expect(store().lastResult).toBeNull();
    expect(store().error).toBeNull();
  });
});
