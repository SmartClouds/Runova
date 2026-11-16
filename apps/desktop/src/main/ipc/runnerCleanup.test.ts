import { describe, expect, it, vi } from 'vitest';
import type {
  RunnerCleanupCleanResult,
  RunnerCleanupItemOutcome,
  RunnerCleanupScanResult,
  RunnerCleanupScheduleResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { fakeWebContents } from '../../test/main/electronMock';
import { expectChannelsCovered, invoke, invokeFrom, loadIpc } from '../../test/main/ipcHarness';
import { DEFAULT_SCHEDULE } from '../pipelines/runnerCleanup/schedule';
import type { RunnerCleanupService } from '../pipelines/runnerCleanup/service';

/**
 * The window can ask this to delete things on a runner machine, so these cover who may ask, that
 * a request can only name a machine link, a scan and item ids, and that progress reaches the
 * window that asked.
 */

expectChannelsCovered(IPC.runnerCleanup, [IPC.runnerCleanup.onProgress]);

const scanResult: RunnerCleanupScanResult = {
  ok: true,
  scan: {
    scanId: 's1',
    os: 'linux',
    scannedAt: 1,
    disk: null,
    groups: [],
    schedule: { installed: false, job: 'cron', schedule: null },
    notes: [],
  },
};

const outcome: RunnerCleanupItemOutcome = { id: 'r0-temp', status: 'done', freedBytes: 5 };
const cleanResult: RunnerCleanupCleanResult = { ok: true, outcomes: [outcome], freedBytes: 5 };
const scheduleResult: RunnerCleanupScheduleResult = {
  ok: true,
  state: { installed: true, job: 'cron', schedule: DEFAULT_SCHEDULE },
};

function rig() {
  const service = {
    scan: vi.fn(async (_link: unknown, onStep?: (step: 'runners') => void) => {
      onStep?.('runners');
      return scanResult;
    }),
    clean: vi.fn(
      async (_request: unknown, onOutcome?: (outcome: RunnerCleanupItemOutcome) => void) => {
        onOutcome?.(outcome);
        return cleanResult;
      },
    ),
    cancel: vi.fn(() => true),
    saveSchedule: vi.fn(async () => scheduleResult),
    removeSchedule: vi.fn(async () => scheduleResult),
  };
  return { service, typed: service as unknown as RunnerCleanupService };
}

async function register(r: ReturnType<typeof rig>, guard?: () => boolean): Promise<void> {
  await loadIpc(
    () => import('./runnerCleanup'),
    (module) => module.registerRunnerCleanupHandlers({ service: r.typed, guard }),
  );
}

const SSH = { kind: 'ssh', serverId: 'server-1' };

describe('scan', () => {
  it('scans the linked machine and tells the calling window each step', async () => {
    const r = rig();
    await register(r);
    const sender = fakeWebContents();
    expect(await invokeFrom(sender, IPC.runnerCleanup.scan, SSH)).toEqual(scanResult);
    expect(r.service.scan.mock.calls[0][0]).toEqual(SSH);
    expect(sender.sentOn(IPC.runnerCleanup.onProgress)).toEqual([
      [{ machine: 'ssh:server-1', phase: 'scan', step: 'runners' }],
    ]);
  });

  it.each([
    ['a path', '/home/ci'],
    ['an unknown kind', { kind: 'rdp', serverId: 'x' }],
    ['an ssh link with no server', { kind: 'ssh' }],
    ['extra fields', { kind: 'local', path: '/' }],
  ])('refuses %s', async (_what, link) => {
    await register(rig());
    await expect(invoke(IPC.runnerCleanup.scan, link)).rejects.toThrow(/not valid/i);
  });

  it('answers the main window only', async () => {
    await register(rig(), () => false);
    await expect(invoke(IPC.runnerCleanup.scan, { kind: 'local' })).rejects.toThrow(/main window/);
  });
});

describe('clean', () => {
  it('passes ids on and reports each item to the calling window', async () => {
    const r = rig();
    await register(r);
    const sender = fakeWebContents();
    const request = { link: { kind: 'local' }, scanId: 's1', itemIds: ['r0-temp'] };
    expect(await invokeFrom(sender, IPC.runnerCleanup.clean, request)).toEqual(cleanResult);
    expect(r.service.clean.mock.calls[0][0]).toEqual(request);
    expect(sender.sentOn(IPC.runnerCleanup.onProgress)).toEqual([
      [{ machine: 'local', phase: 'clean', ...outcome }],
    ]);
  });

  it.each([
    ['a path among the ids', { link: { kind: 'local' }, scanId: 's1', itemIds: ['/etc'] }],
    ['no scan', { link: { kind: 'local' }, itemIds: ['r0-temp'] }],
    ['extra fields', { link: { kind: 'local' }, scanId: 's1', itemIds: ['a'], paths: ['/'] }],
    ['too many ids', { link: { kind: 'local' }, scanId: 's1', itemIds: Array(600).fill('a') }],
  ])('refuses %s', async (_what, request) => {
    await register(rig());
    await expect(invoke(IPC.runnerCleanup.clean, request)).rejects.toThrow(/not valid/i);
  });
});

describe('cancel', () => {
  it('stops the scan on that machine', async () => {
    const r = rig();
    await register(r);
    expect(await invoke(IPC.runnerCleanup.cancel, { kind: 'local' })).toBe(true);
    expect(r.service.cancel).toHaveBeenCalledWith({ kind: 'local' });
  });
});

describe('schedule', () => {
  it('saves and removes the job on the machine', async () => {
    const r = rig();
    await register(r);
    expect(await invoke(IPC.runnerCleanup.saveSchedule, SSH, DEFAULT_SCHEDULE)).toEqual(
      scheduleResult,
    );
    expect(r.service.saveSchedule).toHaveBeenCalledWith(SSH, DEFAULT_SCHEDULE);
    expect(await invoke(IPC.runnerCleanup.removeSchedule, SSH)).toEqual(scheduleResult);
    expect(r.service.removeSchedule).toHaveBeenCalledWith(SSH);
  });

  it('refuses a link that is not valid', async () => {
    await register(rig());
    await expect(
      invoke(IPC.runnerCleanup.saveSchedule, { kind: 'nope' }, DEFAULT_SCHEDULE),
    ).rejects.toThrow(/not valid/i);
  });
});
