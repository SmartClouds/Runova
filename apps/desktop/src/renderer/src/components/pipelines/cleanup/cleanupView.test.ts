import type { RunnerCleanupGroup, RunnerCleanupScan } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import {
  cleanupConfirm,
  defaultPicks,
  describeSchedule,
  diskPercents,
  groupPickState,
  jobLabel,
  selectionBytes,
  toggleGroup,
  toggleItem,
  totalBytes,
} from './cleanupView';

const GB = 1024 ** 3;

const runner: RunnerCleanupGroup = {
  id: 'r0',
  kind: 'runner',
  title: 'build-01',
  status: 'idle',
  items: [
    { id: 'r0-temp', label: 'Temporary files', why: '', bytes: 1 * GB, risk: 'safe', picked: true },
    {
      id: 'r0-actions',
      label: 'Downloaded actions',
      why: '',
      bytes: 2 * GB,
      risk: 'slows',
      picked: false,
    },
    {
      id: 'r0-checkouts',
      label: 'Job checkouts',
      why: '',
      bytes: 4 * GB,
      risk: 'slows',
      picked: false,
      disabledReason: 'A job is running',
    },
  ],
};

const gone: RunnerCleanupGroup = {
  id: 'abandoned',
  kind: 'abandoned',
  title: 'Runners that are gone',
  items: [
    { id: 'gone-1', label: 'old-box', why: '', bytes: 3 * GB, risk: 'careful', picked: false },
  ],
};

const scan: RunnerCleanupScan = {
  scanId: 's1',
  os: 'linux',
  scannedAt: 0,
  disk: { usedBytes: 80 * GB, totalBytes: 100 * GB, mount: '/' },
  groups: [runner, gone],
  schedule: { installed: false, job: 'cron', schedule: null },
  notes: [],
};

describe('picks', () => {
  it('start from what the scan picked, never a disabled item', () => {
    expect([...defaultPicks(scan)]).toEqual(['r0-temp']);
  });

  it('tell a group with all, some or none of its usable items picked', () => {
    expect(groupPickState(runner, new Set())).toBe('none');
    expect(groupPickState(runner, new Set(['r0-temp']))).toBe('some');
    expect(groupPickState(runner, new Set(['r0-temp', 'r0-actions']))).toBe('all');
  });

  it('toggle a whole group, skipping disabled items', () => {
    const all = toggleGroup(runner, new Set(['r0-temp']));
    expect([...all].sort()).toEqual(['r0-actions', 'r0-temp']);
    expect([...toggleGroup(runner, all)]).toEqual([]);
  });

  it('toggle one item', () => {
    expect([...toggleItem('r0-actions', new Set(['r0-temp']))]).toEqual(['r0-temp', 'r0-actions']);
    expect([...toggleItem('r0-temp', new Set(['r0-temp']))]).toEqual([]);
  });
});

describe('sizes', () => {
  it('adds up the picks and everything that could go', () => {
    expect(selectionBytes(scan, new Set(['r0-temp', 'gone-1']))).toBe(4 * GB);
    expect(totalBytes(scan)).toBe(6 * GB);
  });

  it('shows the disk now and after the cleanup', () => {
    expect(diskPercents(scan.disk, 10 * GB)).toEqual({ now: 80, after: 70 });
    expect(diskPercents(scan.disk, 500 * GB)).toEqual({ now: 80, after: 0 });
    expect(diskPercents(null, 1)).toBeNull();
  });
});

describe('cleanupConfirm', () => {
  it('lists what goes and says it is permanent', () => {
    const confirm = cleanupConfirm(scan, new Set(['r0-temp']), 'build server');
    expect(confirm.title).toBe('Free 1.00 GB on build server?');
    expect(confirm.description).toMatch(/cannot be undone/);
    expect(confirm.items).toEqual([{ name: 'build-01: Temporary files', detail: '1.00 GB' }]);
    expect(confirm.warning).toBeUndefined();
    expect(confirm.confirmLabel).toBe('Clean up 1.00 GB');
  });

  it('warns by name when whole runners go', () => {
    const confirm = cleanupConfirm(scan, new Set(['gone-1']), 'build server');
    expect(confirm.warning).toMatch(/old-box/);
    expect(confirm.warning).toMatch(/service/);
  });
});

describe('describeSchedule', () => {
  const base = {
    weekday: 0,
    dayOfMonth: 15,
    time: '03:30',
    rules: {
      temp: true,
      actions: false,
      oldVersions: true,
      toolKeepNewest: true,
      logsOlderThanDays: 14,
      checkoutsOlderThanDays: 7,
      dockerOlderThanHours: 72,
      packageCaches: false,
    },
  };

  it('says when the job runs', () => {
    expect(describeSchedule({ ...base, frequency: 'daily' })).toBe('Every day at 03:30');
    expect(describeSchedule({ ...base, frequency: 'weekly' })).toBe('Every Sunday at 03:30');
    expect(describeSchedule({ ...base, frequency: 'monthly' })).toBe(
      'On day 15 of every month at 03:30',
    );
  });
});

describe('jobLabel', () => {
  it('names what the job is on each OS', () => {
    expect(jobLabel('cron', 'build server')).toBe('a cron job on build server');
    expect(jobLabel('launchd', 'mini')).toBe('a launchd agent on mini');
    expect(jobLabel('task', 'this computer')).toBe('a Task Scheduler task on this computer');
  });
});
