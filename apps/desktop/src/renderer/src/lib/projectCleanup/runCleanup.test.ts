import type {
  CleanupRemoveEvent,
  CleanupScanEvent,
  ProjectCleanupScan,
} from '@shared/projectCleanupTypes';
import { describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { runRemove, runScan } from './runCleanup';

const SCAN: ProjectCleanupScan = {
  projectId: 'p1',
  scannedAt: 1,
  locations: [],
  studio: [],
};

/** A promise that stays pending until the test lets it go, to observe the call while it runs. */
function gate<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runScan', () => {
  it('asks the main process to scan the project and returns what it found', async () => {
    const bridge = installRunovaBridge({ 'projectCleanup.scan': async () => SCAN });
    await expect(runScan('p1')).resolves.toEqual(SCAN);
    expect(bridge.$fn('projectCleanup.scan')).toHaveBeenCalledWith('p1', expect.any(String));
  });

  it('gives every scan its own request id', async () => {
    const bridge = installRunovaBridge({ 'projectCleanup.scan': async () => SCAN });
    await runScan('p1');
    await runScan('p1');
    const calls = bridge.$fn('projectCleanup.scan').mock.calls;
    expect(calls[0]?.[1]).not.toBe(calls[1]?.[1]);
  });

  it('hands over the events of its own scan and ignores the ones of any other', async () => {
    const held = gate<ProjectCleanupScan>();
    const bridge = installRunovaBridge({ 'projectCleanup.scan': () => held.promise });
    const seen: CleanupScanEvent[] = [];
    const running = runScan('p1', { onEvent: (event) => seen.push(event) });
    const requestId = bridge.$fn('projectCleanup.scan').mock.calls[0]?.[1] as string;

    bridge.$emit('projectCleanup.onScanEvent', {
      requestId,
      type: 'location',
      locationId: 'main',
      label: 'Project folder',
      isMain: true,
    });
    bridge.$emit('projectCleanup.onScanEvent', {
      requestId: 'someone-else',
      type: 'progress',
      locationId: 'main',
      files: 99,
    });
    held.resolve(SCAN);
    await running;

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('location');
  });

  it('is listening before the scan starts, so an early event is not lost', async () => {
    const held = gate<ProjectCleanupScan>();
    const bridge = installRunovaBridge({ 'projectCleanup.scan': () => held.promise });
    const running = runScan('p1');
    expect(bridge.$listenerCount('projectCleanup.onScanEvent')).toBe(1);
    held.resolve(SCAN);
    await running;
  });

  it('stops listening when the scan ends, and when it fails', async () => {
    const ok = installRunovaBridge({ 'projectCleanup.scan': async () => SCAN });
    await runScan('p1');
    expect(ok.$listenerCount('projectCleanup.onScanEvent')).toBe(0);

    const bad = installRunovaBridge({
      'projectCleanup.scan': async () => {
        throw new Error('That project no longer exists.');
      },
    });
    await expect(runScan('p1')).rejects.toThrow('That project no longer exists.');
    expect(bad.$listenerCount('projectCleanup.onScanEvent')).toBe(0);
  });

  it('tells the main process to stop when the signal fires', async () => {
    const held = gate<ProjectCleanupScan>();
    const bridge = installRunovaBridge({
      'projectCleanup.scan': () => held.promise,
      'projectCleanup.cancel': async () => true,
    });
    const controller = new AbortController();
    const running = runScan('p1', { signal: controller.signal });
    const requestId = bridge.$fn('projectCleanup.scan').mock.calls[0]?.[1];
    controller.abort();
    expect(bridge.$fn('projectCleanup.cancel')).toHaveBeenCalledWith(requestId);
    held.resolve(SCAN);
    await running.catch(() => undefined);
  });

  it('reports a cancelled scan as an AbortError, however main words it', async () => {
    const held = gate<ProjectCleanupScan>();
    installRunovaBridge({
      'projectCleanup.scan': () => held.promise,
      'projectCleanup.cancel': async () => true,
    });
    const controller = new AbortController();
    const running = runScan('p1', { signal: controller.signal });
    controller.abort();
    held.reject(
      new Error("Error invoking remote method 'projectCleanup:scan': The scan was cancelled."),
    );
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not start at all when the signal was already aborted', async () => {
    const scan = vi.fn(async () => SCAN);
    installRunovaBridge({ 'projectCleanup.scan': scan });
    const controller = new AbortController();
    controller.abort();
    await expect(runScan('p1', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it('turns an empty answer into an error instead of passing it on', async () => {
    installRunovaBridge({ 'projectCleanup.scan': async () => undefined });
    await expect(runScan('p1')).rejects.toThrow(/did not answer/i);
  });

  it("keeps main's own wording for a real failure", async () => {
    installRunovaBridge({
      'projectCleanup.scan': async () => {
        throw new Error('Clean-up is already working on this project.');
      },
    });
    await expect(runScan('p1')).rejects.toThrow('Clean-up is already working on this project.');
  });
});

describe('runRemove', () => {
  const ITEMS = [{ kind: 'folder' as const, locationId: 'main', relPath: 'dist' }];
  const RESULT = { freedBytes: 5, removed: ['main:dist'], failed: [] };

  it('sends the items and returns the result', async () => {
    const bridge = installRunovaBridge({ 'projectCleanup.remove': async () => RESULT });
    await expect(runRemove('p1', ITEMS)).resolves.toEqual(RESULT);
    expect(bridge.$fn('projectCleanup.remove')).toHaveBeenCalledWith(
      'p1',
      expect.any(String),
      ITEMS,
    );
  });

  it('hands over the events of its own removal only', async () => {
    const held = gate<typeof RESULT>();
    const bridge = installRunovaBridge({ 'projectCleanup.remove': () => held.promise });
    const seen: CleanupRemoveEvent[] = [];
    const running = runRemove('p1', ITEMS, { onEvent: (event) => seen.push(event) });
    const requestId = bridge.$fn('projectCleanup.remove').mock.calls[0]?.[1] as string;
    bridge.$emit('projectCleanup.onRemoveEvent', {
      requestId,
      key: 'main:dist',
      status: 'removing',
    });
    bridge.$emit('projectCleanup.onRemoveEvent', { requestId: 'other', key: 'x', status: 'done' });
    held.resolve(RESULT);
    await running;
    expect(seen).toEqual([{ requestId, key: 'main:dist', status: 'removing' }]);
    expect(bridge.$listenerCount('projectCleanup.onRemoveEvent')).toBe(0);
  });

  it('can be cancelled', async () => {
    const held = gate<typeof RESULT>();
    const bridge = installRunovaBridge({
      'projectCleanup.remove': () => held.promise,
      'projectCleanup.cancel': vi.fn(async () => true),
    });
    const controller = new AbortController();
    const running = runRemove('p1', ITEMS, { signal: controller.signal });
    controller.abort();
    expect(bridge.$fn('projectCleanup.cancel')).toHaveBeenCalled();
    held.resolve(RESULT);
    await running;
  });

  it('turns an empty answer into an error', async () => {
    installRunovaBridge({ 'projectCleanup.remove': async () => undefined });
    await expect(runRemove('p1', ITEMS)).rejects.toThrow(/did not answer/i);
  });
});
