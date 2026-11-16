import type {
  RunnerCleanupCleanResult,
  RunnerCleanupScan,
  RunnerCleanupScanResult,
} from '@shared/apiTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { useRunnerCleanupStore, machineState } = await import('./runnerCleanupStore');

const LOCAL = { kind: 'local' as const };
const KEY = 'local';
const GB = 1024 ** 3;

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const scan: RunnerCleanupScan = {
  scanId: 's1',
  os: 'linux',
  scannedAt: 0,
  disk: null,
  groups: [
    {
      id: 'r0',
      kind: 'runner',
      title: 'build-01',
      status: 'idle',
      items: [
        { id: 'r0-temp', label: 'Temp', why: '', bytes: GB, risk: 'safe', picked: true },
        { id: 'r0-actions', label: 'Actions', why: '', bytes: GB, risk: 'slows', picked: false },
      ],
    },
  ],
  schedule: { installed: false, job: 'cron', schedule: null },
  notes: [],
};

const store = () => useRunnerCleanupStore.getState();
const state = () => machineState(store(), KEY);

function held<T>() {
  return deferred<T>();
}

beforeEach(() => {
  useRunnerCleanupStore.setState({ machines: {} });
  vi.clearAllMocks();
});

describe('scan', () => {
  it('follows the steps and starts from the scan’s own picks', async () => {
    const answer = held<RunnerCleanupScanResult>();
    const bridge = installRunovaBridge({ 'runnerCleanup.scan': () => answer.promise });
    const running = store().scan(LOCAL);
    expect(state().phase).toBe('scanning');
    bridge.$emit('runnerCleanup.onProgress', { machine: KEY, phase: 'scan', step: 'runners' });
    bridge.$emit('runnerCleanup.onProgress', { machine: 'ssh:x', phase: 'scan', step: 'docker' });
    expect(state().steps).toEqual(['runners']);
    answer.resolve({ ok: true, scan });
    await running;
    expect(state()).toMatchObject({ phase: 'ready', scan, picks: ['r0-temp'], error: null });
    expect(bridge.$listenerCount('runnerCleanup.onProgress')).toBe(0);
  });

  it('keeps why a scan failed', async () => {
    installRunovaBridge({
      'runnerCleanup.scan': async () => ({ ok: false, reason: 'locked', error: 'Vault locked' }),
    });
    await store().scan(LOCAL);
    expect(state()).toMatchObject({
      phase: 'failed',
      error: { reason: 'locked', message: 'Vault locked' },
    });
  });

  it('turns a rejected call into a failure', async () => {
    installRunovaBridge({
      'runnerCleanup.scan': async () => {
        throw new Error('boom');
      },
    });
    await store().scan(LOCAL);
    expect(state()).toMatchObject({ phase: 'failed', error: { reason: 'unreachable' } });
  });

  it('stops a scan', async () => {
    const bridge = installRunovaBridge({ 'runnerCleanup.cancel': async () => true });
    await store().cancelScan(LOCAL);
    expect(bridge.$fn('runnerCleanup.cancel')).toHaveBeenCalledWith(LOCAL);
  });
});

describe('picks', () => {
  it('can be changed', () => {
    store().setPicks(KEY, ['r0-actions']);
    expect(state().picks).toEqual(['r0-actions']);
  });
});

describe('clean', () => {
  async function ready(overrides: Record<string, unknown>) {
    const bridge = installRunovaBridge({
      'runnerCleanup.scan': async () => ({ ok: true, scan }),
      ...overrides,
    });
    await store().scan(LOCAL);
    return bridge;
  }

  it('cleans the picks, follows each item and toasts what it freed', async () => {
    const answer = held<RunnerCleanupCleanResult>();
    const bridge = await ready({ 'runnerCleanup.clean': () => answer.promise });
    const running = store().clean(LOCAL, 'build server');
    expect(bridge.$fn('runnerCleanup.clean')).toHaveBeenCalledWith({
      link: LOCAL,
      scanId: 's1',
      itemIds: ['r0-temp'],
    });
    expect(state()).toMatchObject({ phase: 'cleaning', running: ['r0-temp'] });
    const outcome = { id: 'r0-temp', status: 'done', freedBytes: GB };
    bridge.$emit('runnerCleanup.onProgress', { machine: KEY, phase: 'clean', ...outcome });
    expect(state().outcomes['r0-temp']).toEqual(outcome);
    answer.resolve({ ok: true, outcomes: [outcome as never], freedBytes: GB });
    await running;
    expect(state()).toMatchObject({ phase: 'done', freedBytes: GB, running: [] });
    expect(toast.success).toHaveBeenCalledWith('Freed 1.00 GB on build server');
  });

  it('warns when some items could not be removed', async () => {
    await ready({
      'runnerCleanup.clean': async () => ({
        ok: true,
        outcomes: [{ id: 'r0-temp', status: 'failed', freedBytes: 0, error: 'Permission denied' }],
        freedBytes: 0,
      }),
    });
    await store().clean(LOCAL, 'build server');
    expect(toast.warning).toHaveBeenCalledWith(
      'Freed 0 B on build server. 1 item could not be removed.',
    );
  });

  it('goes back to the list when the cleanup is refused', async () => {
    await ready({
      'runnerCleanup.clean': async () => ({ ok: false, reason: 'refused', error: 'Out of date' }),
    });
    await store().clean(LOCAL, 'build server');
    expect(state()).toMatchObject({ phase: 'failed', error: { message: 'Out of date' } });
    expect(toast.error).toHaveBeenCalled();
  });

  it('does nothing without picks', async () => {
    const clean = vi.fn();
    await ready({ 'runnerCleanup.clean': clean });
    store().setPicks(KEY, []);
    await store().clean(LOCAL, 'build server');
    expect(clean).not.toHaveBeenCalled();
  });
});

describe('schedule', () => {
  it('replaces the schedule state of the held scan', async () => {
    installRunovaBridge({ 'runnerCleanup.scan': async () => ({ ok: true, scan }) });
    await store().scan(LOCAL);
    const next = { installed: true, job: 'cron' as const, schedule: null };
    store().setScheduleState(KEY, next);
    expect(state().scan?.schedule).toEqual(next);
  });
});
