import { describe, expect, it } from 'vitest';
import type { RunnerCleanupSchedule } from '../../../shared/apiTypes';
import {
  CONFIG_PREFIX,
  configLine,
  cronLine,
  DEFAULT_SCHEDULE,
  launchdPlist,
  normalizeSchedule,
  parseLastRun,
  readScheduleConfig,
  TASK_SCRIPT_TOKEN,
  TASK_USER_TOKEN,
  taskXml,
} from './schedule';

const weekly: RunnerCleanupSchedule = {
  ...DEFAULT_SCHEDULE,
  frequency: 'weekly',
  weekday: 0,
  time: '03:30',
};

describe('normalizeSchedule', () => {
  it('accepts the default', () => {
    expect(normalizeSchedule(DEFAULT_SCHEDULE)).toEqual(DEFAULT_SCHEDULE);
  });

  it('refuses a time, day or rule that is out of range', () => {
    expect(normalizeSchedule({ ...weekly, time: '24:00' })).toBeNull();
    expect(normalizeSchedule({ ...weekly, time: '3:5' })).toBeNull();
    expect(normalizeSchedule({ ...weekly, weekday: 7 })).toBeNull();
    expect(normalizeSchedule({ ...weekly, dayOfMonth: 29 })).toBeNull();
    expect(normalizeSchedule({ ...weekly, frequency: 'hourly' })).toBeNull();
    expect(
      normalizeSchedule({ ...weekly, rules: { ...weekly.rules, logsOlderThanDays: 0 } }),
    ).toBeNull();
    expect(
      normalizeSchedule({ ...weekly, rules: { ...weekly.rules, checkoutsOlderThanDays: 1.5 } }),
    ).toBeNull();
    expect(normalizeSchedule(null)).toBeNull();
    expect(normalizeSchedule({ ...weekly, extra: true })).toBeNull();
  });

  it('allows an age rule to be off', () => {
    const schedule = { ...weekly, rules: { ...weekly.rules, dockerOlderThanHours: null } };
    expect(normalizeSchedule(schedule)).toEqual(schedule);
  });
});

describe('configLine and readScheduleConfig', () => {
  it('round-trips through the comment line the script on the machine carries', () => {
    const text = configLine(weekly);
    expect(text.startsWith(CONFIG_PREFIX)).toBe(true);
    expect(text).not.toContain('\n');
    expect(readScheduleConfig(text.slice(CONFIG_PREFIX.length))).toEqual(weekly);
  });

  it('is null for a line someone edited into nonsense', () => {
    expect(readScheduleConfig('{')).toBeNull();
    expect(readScheduleConfig(null)).toBeNull();
  });
});

describe('cronLine', () => {
  it('writes daily, weekly and monthly in cron fields', () => {
    expect(cronLine({ ...weekly, frequency: 'daily' }, 'run')).toBe('30 3 * * * run');
    expect(cronLine(weekly, 'run')).toBe('30 3 * * 0 run');
    expect(cronLine({ ...weekly, frequency: 'monthly', dayOfMonth: 15 }, 'run')).toBe(
      '30 3 15 * * run',
    );
  });
});

describe('launchdPlist', () => {
  it('runs the script with sh on the calendar interval', () => {
    const plist = launchdPlist(weekly, '/Users/ci/.runova/runner-cleanup.sh');
    expect(plist).toContain('<string>com.runova.runner-cleanup</string>');
    expect(plist).toContain('<string>/bin/sh</string>');
    expect(plist).toContain('<string>/Users/ci/.runova/runner-cleanup.sh</string>');
    expect(plist).toContain('<key>Hour</key><integer>3</integer>');
    expect(plist).toContain('<key>Minute</key><integer>30</integer>');
    expect(plist).toContain('<key>Weekday</key><integer>0</integer>');
    expect(plist).not.toContain('<key>Day</key>');
  });

  it('uses Day for a monthly job and neither for a daily one', () => {
    expect(launchdPlist({ ...weekly, frequency: 'monthly', dayOfMonth: 2 }, '/s')).toContain(
      '<key>Day</key><integer>2</integer>',
    );
    const daily = launchdPlist({ ...weekly, frequency: 'daily' }, '/s');
    expect(daily).not.toContain('<key>Weekday</key>');
    expect(daily).not.toContain('<key>Day</key>');
  });

  it('escapes the script path for XML', () => {
    expect(launchdPlist(weekly, '/Users/a&b/s.sh')).toContain('/Users/a&amp;b/s.sh');
  });
});

describe('taskXml', () => {
  it('starts at the set time, catches up after the machine was off and runs while signed out', () => {
    const xml = taskXml(weekly);
    expect(xml).toContain('<StartBoundary>2026-01-01T03:30:00</StartBoundary>');
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<LogonType>S4U</LogonType>');
    expect(xml).toContain(`<UserId>${TASK_USER_TOKEN}</UserId>`);
    expect(xml).toContain(TASK_SCRIPT_TOKEN);
    expect(xml).toContain('<ScheduleByWeek>');
    expect(xml).toContain('<Sunday />');
  });

  it('writes a monthly and a daily trigger', () => {
    const monthly = taskXml({ ...weekly, frequency: 'monthly', dayOfMonth: 28 });
    expect(monthly).toContain('<DaysOfMonth><Day>28</Day></DaysOfMonth>');
    expect(monthly).toContain('<December />');
    expect(taskXml({ ...weekly, frequency: 'daily' })).toContain(
      '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    );
  });
});

describe('parseLastRun', () => {
  it('reads the log line the job writes', () => {
    expect(parseLastRun('2026-11-15T03:00:01Z\t2048\tok')).toEqual({
      at: '2026-11-15T03:00:01Z',
      freedBytes: 2048 * 1024,
      ok: true,
    });
    expect(parseLastRun('2026-11-15T03:00:01Z\t-10\tfailed')).toEqual({
      at: '2026-11-15T03:00:01Z',
      freedBytes: 0,
      ok: false,
    });
  });

  it('is undefined for anything else', () => {
    expect(parseLastRun(null)).toBeUndefined();
    expect(parseLastRun('garbage')).toBeUndefined();
  });
});
