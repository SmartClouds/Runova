import type {
  CleanResult,
  CleanSelection,
  ProviderScan,
  SystemCleanEvent,
  SystemCleanupScan,
  SystemScanEvent,
} from '@runova/core';
import { describe, expect, it } from 'vitest';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { isCancelled, runClean, runScan } from './runner';

const SCAN: SystemCleanupScan = {
  scanId: 's1',
  startedAt: 1,
  finishedAt: 2,
  cancelled: false,
  providers: [],
  volumes: [],
};

const PROVIDER = { id: 'nuget' } as ProviderScan;

const RESULT: CleanResult = {
  providerId: 'nuget',
  removed: 1,
  freedBytes: 10,
  failed: [],
  skipped: [],
  cancelled: false,
  provider: PROVIDER,
};

const CHOICE: CleanSelection = { mode: 'old-versions', providerId: 'nuget', keep: 1 };

/** A promise that stays pending until the test lets it go, to watch the call while it runs. */
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
  it('asks the main process to scan, and returns what it found', async () => {
    const bridge = installRunovaBridge({ 'systemCleanup.scan': async () => SCAN });
    await expect(runScan()).resolves.toEqual(SCAN);
    expect(bridge.$fn('systemCleanup.scan')).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('can scan just some of the caches', async () => {
    const bridge = installRunovaBridge({ 'systemCleanup.scan': async () => SCAN });
    await runScan({ providerIds: ['nuget', 'bun'] });
    expect(bridge.$fn('systemCleanup.scan')).toHaveBeenCalledWith(expect.any(String), [
      'nuget',
      'bun',
    ]);
  });

  it('gives every scan its own request id', async () => {
    const bridge = installRunovaBridge({ 'systemCleanup.scan': async () => SCAN });
    await runScan();
    await runScan();
    const calls = bridge.$fn('systemCleanup.scan').mock.calls;
    expect(calls[0]?.[0]).not.toBe(calls[1]?.[0]);
  });

  it('hands over the events of its own scan and ignores the ones of any other', async () => {
    const held = gate<SystemCleanupScan>();
    const bridge = installRunovaBridge({ 'systemCleanup.scan': () => held.promise });
    const seen: SystemScanEvent[] = [];
    const running = runScan({ onEvent: (event) => seen.push(event) });
    const requestId = bridge.$fn('systemCleanup.scan').mock.calls[0]?.[0] as string;

    bridge.$emit('systemCleanup.onScanEvent', {
      type: 'provider-started',
      requestId,
      providerId: 'nuget',
    });
    bridge.$emit('systemCleanup.onScanEvent', {
      type: 'progress',
      requestId: 'someone-else',
      providerId: 'nuget',
      bytes: 9,
      files: 9,
    });
    held.resolve(SCAN);
    await running;

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('provider-started');
  });

  it('is listening before the scan starts, so an early event is not lost', async () => {
    const held = gate<SystemCleanupScan>();
    const bridge = installRunovaBridge({ 'systemCleanup.scan': () => held.promise });
    const running = runScan();
    expect(bridge.$listenerCount('systemCleanup.onScanEvent')).toBe(1);
    held.resolve(SCAN);
    await running;
  });

  it('stops listening when it is done, however it ends', async () => {
    const bridge = installRunovaBridge({ 'systemCleanup.scan': async () => SCAN });
    await runScan();
    expect(bridge.$listenerCount('systemCleanup.onScanEvent')).toBe(0);

    const failing = installRunovaBridge({
      'systemCleanup.scan': async () => {
        throw new Error('boom');
      },
    });
    await expect(runScan()).rejects.toThrow('boom');
    expect(failing.$listenerCount('systemCleanup.onScanEvent')).toBe(0);
  });

  it('tells the main process to stop when it is cancelled, and ends as a cancellation', async () => {
    const held = gate<SystemCleanupScan>();
    const bridge = installRunovaBridge({
      'systemCleanup.scan': () => held.promise,
      'systemCleanup.cancel': async () => true,
    });
    const controller = new AbortController();
    const running = runScan({ signal: controller.signal });
    const requestId = bridge.$fn('systemCleanup.scan').mock.calls[0]?.[0];

    controller.abort();
    held.reject(new Error('Error invoking remote method: cancelled'));
    const error = await running.catch((caught: unknown) => caught);

    expect(isCancelled(error)).toBe(true);
    expect(bridge.$fn('systemCleanup.cancel')).toHaveBeenCalledWith(requestId);
  });

  it('does not start when it was cancelled already', async () => {
    const bridge = installRunovaBridge({ 'systemCleanup.scan': async () => SCAN });
    const controller = new AbortController();
    controller.abort();
    const error = await runScan({ signal: controller.signal }).catch((caught: unknown) => caught);
    expect(isCancelled(error)).toBe(true);
    // The bridge only knows a call the code under test made.
    expect(() => bridge.$fn('systemCleanup.scan')).toThrow(/has not been touched/);
  });

  it('says so when the main process gives no answer', async () => {
    installRunovaBridge({ 'systemCleanup.scan': async () => undefined });
    await expect(runScan()).rejects.toThrow(/did not answer/i);
  });
});

describe('runClean', () => {
  it('sends the scan and the choice, and returns the result', async () => {
    const bridge = installRunovaBridge({ 'systemCleanup.clean': async () => RESULT });
    await expect(runClean('s1', CHOICE)).resolves.toEqual(RESULT);
    expect(bridge.$fn('systemCleanup.clean')).toHaveBeenCalledWith(
      expect.any(String),
      's1',
      CHOICE,
    );
  });

  it('hands over the events of its own clean-up only', async () => {
    const held = gate<CleanResult>();
    const bridge = installRunovaBridge({ 'systemCleanup.clean': () => held.promise });
    const seen: SystemCleanEvent[] = [];
    const running = runClean('s1', CHOICE, { onEvent: (event) => seen.push(event) });
    const requestId = bridge.$fn('systemCleanup.clean').mock.calls[0]?.[0] as string;

    bridge.$emit('systemCleanup.onCleanEvent', {
      type: 'item-done',
      requestId,
      providerId: 'nuget',
      itemId: 'a',
      label: 'a 1.0.0',
      bytes: 5,
    });
    bridge.$emit('systemCleanup.onCleanEvent', {
      type: 'item-done',
      requestId: 'other',
      providerId: 'nuget',
      itemId: 'b',
      label: 'b',
      bytes: 5,
    });
    held.resolve(RESULT);
    await running;

    expect(seen).toHaveLength(1);
    expect(bridge.$listenerCount('systemCleanup.onCleanEvent')).toBe(0);
  });

  it('can be cancelled', async () => {
    const held = gate<CleanResult>();
    const bridge = installRunovaBridge({
      'systemCleanup.clean': () => held.promise,
      'systemCleanup.cancel': async () => true,
    });
    const controller = new AbortController();
    const running = runClean('s1', CHOICE, { signal: controller.signal });
    controller.abort();
    held.resolve(RESULT);
    await running.catch(() => undefined);
    expect(bridge.$fn('systemCleanup.cancel')).toHaveBeenCalledTimes(1);
  });
});

describe('isCancelled', () => {
  it('tells the person stopping a run from a run failing', () => {
    expect(isCancelled(new DOMException('Cancelled.', 'AbortError'))).toBe(true);
    expect(isCancelled(new Error('boom'))).toBe(false);
    expect(isCancelled(null)).toBe(false);
    expect(isCancelled('AbortError')).toBe(false);
  });
});
