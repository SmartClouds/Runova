import { describe, expect, it } from 'vitest';
import type {
  AttackSettings,
  AutoBlockSettings,
  TrafficSettings,
} from './protocol/generated/Runova.ServerCore.Contracts';
import {
  ATTACK_KINDS,
  attackKindLabel,
  checkAttackSettings,
  checkAutoBlock,
  checkNetwork,
  checkTrafficSettings,
  DEFAULT_THRESHOLDS,
  isTimeZone,
  TRAFFIC_LIMITS,
} from './trafficValidation';

const SETTINGS: TrafficSettings = {
  enabled: true,
  countries: true,
  excludedSites: ['blog'],
  hourlyRetentionDays: 90,
  dailyRetentionDays: 730,
  timeZone: 'Europe/Berlin',
  readExistingLogs: false,
};

const ATTACKS: AttackSettings = {
  enabled: true,
  thresholds: { ...DEFAULT_THRESHOLDS },
  allowlist: ['203.0.113.7', '10.0.0.0/8', '2001:db8::/32'],
  eventRetentionDays: 30,
};

const AUTO: AutoBlockSettings = { enabled: true, kinds: ['scan'], minutes: 60, maxBlocked: 1000 };

describe('checkNetwork', () => {
  it('takes an address or a range, trimmed', () => {
    expect(checkNetwork(' 203.0.113.7 ')).toEqual({ ok: true, value: '203.0.113.7' });
    expect(checkNetwork('10.0.0.0/8')).toEqual({ ok: true, value: '10.0.0.0/8' });
    expect(checkNetwork('2001:db8::1')).toEqual({ ok: true, value: '2001:db8::1' });
    expect(checkNetwork('2001:DB8::/32')).toEqual({ ok: true, value: '2001:db8::/32' });
    expect(checkNetwork('::1')).toEqual({ ok: true, value: '::1' });
  });

  it('refuses anything else, saying what it wants', () => {
    for (const bad of [
      '',
      'example.com',
      '300.1.1.1',
      '1.2.3',
      '10.0.0.0/33',
      '::1/129',
      '1::2::3',
      '1.2.3.4/',
    ]) {
      const result = checkNetwork(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/address/);
    }
  });
});

describe('isTimeZone', () => {
  it('knows IANA names and nothing else', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});

describe('checkTrafficSettings', () => {
  it('passes settings within the core limits', () => {
    expect(checkTrafficSettings(SETTINGS)).toEqual([]);
  });

  it('names each limit that is broken', () => {
    expect(
      checkTrafficSettings({
        ...SETTINGS,
        hourlyRetentionDays: 6,
        dailyRetentionDays: 2000,
        timeZone: 'Nowhere/Land',
      }),
    ).toEqual([
      'Keep hourly figures for 7 to 365 days.',
      'Keep daily figures for 30 to 1825 days.',
      'Pick a time zone from the list.',
    ]);
    expect(checkTrafficSettings({ ...SETTINGS, hourlyRetentionDays: 7.5 })).toEqual([
      'Keep hourly figures for 7 to 365 days.',
    ]);
  });

  it('refuses a site id that is not one and too many of them', () => {
    expect(checkTrafficSettings({ ...SETTINGS, excludedSites: ['Bad Id'] })).toEqual([
      'Bad Id is not a site.',
    ]);
    const many = Array.from({ length: TRAFFIC_LIMITS.maxExcludedSites + 1 }, (_, i) => `s${i}`);
    expect(checkTrafficSettings({ ...SETTINGS, excludedSites: many })).toEqual([
      `Leave out at most ${TRAFFIC_LIMITS.maxExcludedSites} sites.`,
    ]);
  });
});

describe('checkAttackSettings', () => {
  it('passes the defaults', () => {
    expect(checkAttackSettings(ATTACKS)).toEqual([]);
  });

  it('wants every threshold a positive whole number within reason', () => {
    expect(
      checkAttackSettings({
        ...ATTACKS,
        thresholds: { ...DEFAULT_THRESHOLDS, scanProbes: 0, floodRequestsPerMinute: -3 },
      }),
    ).toEqual([
      'Probe paths must be a whole number from 3 to 10000.',
      'Requests a minute must be a whole number from 60 to 1000000.',
    ]);
    expect(
      checkAttackSettings({
        ...ATTACKS,
        thresholds: { ...DEFAULT_THRESHOLDS, scanWindowMinutes: 61, injectionHits: 1 },
      }),
    ).toEqual(['The scan window must be a whole number from 1 to 60.']);
  });

  it('checks the allowlist and the event retention', () => {
    expect(
      checkAttackSettings({ ...ATTACKS, allowlist: ['nope'], eventRetentionDays: 400 }),
    ).toEqual([
      'nope: write an address such as 203.0.113.7 or a range such as 10.0.0.0/8.',
      'Keep attack events for 7 to 365 days.',
    ]);
    const many = Array.from(
      { length: TRAFFIC_LIMITS.maxAllowlist + 1 },
      (_, i) => `10.0.${i >> 8}.${i & 255}`,
    );
    expect(checkAttackSettings({ ...ATTACKS, allowlist: many })).toEqual([
      `The allowlist takes at most ${TRAFFIC_LIMITS.maxAllowlist} entries.`,
    ]);
  });
});

describe('checkAutoBlock', () => {
  it('passes a sound setup, and anything when it is off', () => {
    expect(checkAutoBlock(AUTO)).toEqual([]);
    expect(checkAutoBlock({ ...AUTO, minutes: 0 })).toEqual([]);
    expect(checkAutoBlock({ enabled: false, kinds: [], minutes: 60, maxBlocked: 1000 })).toEqual(
      [],
    );
  });

  it('wants a kind, a sane length and a cap up to 1000', () => {
    expect(checkAutoBlock({ ...AUTO, kinds: [] })).toEqual([
      'Pick at least one kind of attack to block.',
    ]);
    expect(checkAutoBlock({ ...AUTO, maxBlocked: 100_000 })).toEqual([]);
    expect(checkAutoBlock({ ...AUTO, minutes: -1, maxBlocked: 100_001 })).toEqual([
      'Block for 0 (for good) to 525600 minutes.',
      'Cap blocked addresses at 1 to 100000.',
    ]);
    expect(checkAutoBlock({ ...AUTO, kinds: ['scan', 'nope' as never] })).toEqual([
      'nope is not a kind of attack.',
    ]);
  });
});

describe('ATTACK_KINDS', () => {
  it('names every kind the core knows', () => {
    expect(ATTACK_KINDS.map((kind) => kind.value)).toEqual([
      'scan',
      'bruteForce',
      'flood',
      'injection',
    ]);
    expect(attackKindLabel('bruteForce')).toBe('Password guessing');
  });
});
