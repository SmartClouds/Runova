import { MANAGE_METHODS } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FakeTraffic, sampleAttacks } from '../../../shared/deploy/testing/fakeTraffic';
import { OLDER_CORE } from '../../deploy/traffic/service';
import { ManageError } from './session';
import { type ManageTrafficDeps, trafficMethods } from './trafficMethods';

/**
 * Website traffic and attacks for a phone (E111), through the desktop's own traffic service and its
 * input checks. The phone picks a preset range and the computer works out the window in the
 * report's time zone, so both apps count the same days. Auto-block and deleting statistics stay on
 * the computer.
 */

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['deploy' as const] } };
const DAY = 86_400_000;
/** Wednesday 18 November 2026, 14:30 UTC. */
const NOW = Date.UTC(2026, 10, 18, 14, 30);
const MIDNIGHT = Date.UTC(2026, 10, 18);

function deps(change: Partial<ManageTrafficDeps['traffic']> = {}, role = 'Admin') {
  const fake = new FakeTraffic({
    now: () => NOW,
    userName: () => 'sam',
    sites: () => [
      { siteId: 'blog', domains: ['blog.example.com'] },
      { siteId: 'shop', domains: ['shop.example.com', 'www.shop.example.com'] },
    ],
  });
  fake.settings.enabled = true;
  const saved = (result: { problems: string[]; status?: unknown }) => ({
    problems: result.problems,
    status: (result.status ?? null) as never,
  });
  const traffic = {
    status: vi.fn(async (_id: string) => fake.status()),
    report: vi.fn(async ({ serverId: _s, ...request }) => fake.report(request)),
    dimension: vi.fn(async ({ serverId: _s, ...request }) => fake.dimension(request)),
    saveSettings: vi.fn(async ({ settings }) => saved(fake.saveSettings(settings))),
    saveAttackSettings: vi.fn(async ({ settings }) => saved(fake.saveAttackSettings(settings))),
    attacks: vi.fn(async ({ serverId: _s, ...query }) => ({
      events: sampleAttacks(NOW),
      series: [{ startUnixMs: MIDNIGHT, scan: 1, bruteForce: 1, flood: 1, injection: 1 }],
      addresses: 4,
      blocked: 0,
      query,
    })),
    blocked: vi.fn(async (_id: string) => fake.blocked()),
    block: vi.fn(async ({ serverId: _s, ...request }) => fake.block(request)),
    unblock: vi.fn(async ({ blockId }) => fake.unblock(blockId)),
    ...change,
  } as unknown as ManageTrafficDeps['traffic'];
  const all: ManageTrafficDeps = {
    access: vi.fn(async () => ({
      state: 'signed-in' as const,
      user: { userName: 'sam', roles: [role], twoFactorEnabled: false },
    })),
    traffic,
    now: () => NOW,
  };
  return { deps: all, traffic, fake };
}

function call(d: ManageTrafficDeps, method: string, params: unknown) {
  const handler = trafficMethods(d)[method];
  if (!handler) throw new Error(`no ${method}`);
  return handler(params, context) as Promise<Record<string, unknown>>;
}

async function refused(work: Promise<unknown>): Promise<ManageError> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ManageError);
  return error as ManageError;
}

describe('trafficMethods', () => {
  it('puts every method under deploy, with blocking and unblocking marked dangerous', () => {
    const names = Object.keys(trafficMethods(deps().deps));
    expect(names.sort()).toEqual(
      [
        'deploy.traffic',
        'deploy.trafficAttacks',
        'deploy.trafficBlock',
        'deploy.trafficBlocked',
        'deploy.trafficDimension',
        'deploy.trafficSaveSettings',
        'deploy.trafficStatus',
        'deploy.trafficUnblock',
      ].sort(),
    );
    for (const name of names) {
      expect(MANAGE_METHODS[name], name).toMatchObject({ scope: 'deploy' });
    }
    expect(MANAGE_METHODS['deploy.trafficBlock']?.risk).toBe('danger');
    expect(MANAGE_METHODS['deploy.trafficUnblock']?.risk).toBe('danger');
    expect(MANAGE_METHODS['deploy.trafficSaveSettings']?.risk).toBe('write');
    for (const read of ['traffic', 'trafficDimension', 'trafficStatus', 'trafficAttacks']) {
      expect(MANAGE_METHODS[`deploy.${read}`]?.risk, read).toBe('read');
    }
  });

  it('leaves auto-block and deleting statistics on the computer', () => {
    const names = Object.keys(MANAGE_METHODS);
    expect(names.filter((name) => /autoBlock|deleteData|trafficDelete/i.test(name))).toEqual([]);
  });

  it('works out the window in the report time zone and picks the bucket for the range', async () => {
    const { deps: d, traffic } = deps();

    const report = await call(d, 'deploy.traffic', { serverId: 'srv-1', range: '7d' });

    expect(traffic.report).toHaveBeenCalledWith({
      serverId: 'srv-1',
      fromUnixMs: MIDNIGHT - 6 * DAY,
      toUnixMs: NOW,
      granularity: 'day',
      compare: true,
    });
    expect(report).toMatchObject({
      role: 'admin',
      range: '7d',
      granularity: 'day',
      fromUnixMs: MIDNIGHT - 6 * DAY,
      toUnixMs: NOW,
      timeZone: 'UTC',
      enabled: true,
      siteId: null,
    });
    const series = report.series as { axis: string; label: string; visitors: number }[];
    expect(series).toHaveLength(7);
    expect(series[6]).toMatchObject({ axis: '18 Nov', label: 'Wed 18 Nov 2026' });
    expect((report.previousSeries as unknown[]).length).toBe(7);
    expect(report.previous).toBeTruthy();
    expect(report.sites).toEqual([
      { id: 'blog', label: 'blog.example.com' },
      { id: 'shop', label: 'shop.example.com' },
    ]);
    const granularities = report.granularities as { value: string; enabled: boolean }[];
    expect(granularities.map((g) => [g.value, g.enabled])).toEqual([
      ['hour', true],
      ['day', true],
      ['week', false],
      ['month', false],
    ]);
  });

  it('keeps a granularity the range allows and falls back from one it does not', async () => {
    const { deps: d, traffic } = deps();

    await call(d, 'deploy.traffic', { serverId: 'srv-1', range: 'today', granularity: 'hour' });
    await call(d, 'deploy.traffic', { serverId: 'srv-1', range: '90d', granularity: 'hour' });

    const asked = vi.mocked(traffic.report).mock.calls.map(([input]) => input.granularity);
    expect(asked).toEqual(['hour', 'week']);
  });

  it('reads one site, and caps each breakdown at what the phone shows, countries named', async () => {
    const { deps: d, traffic } = deps();

    const report = await call(d, 'deploy.traffic', {
      serverId: 'srv-1',
      siteId: 'blog',
      range: '30d',
    });

    expect(vi.mocked(traffic.report).mock.calls[0]?.[0]).toMatchObject({ siteId: 'blog' });
    const breakdowns = report.breakdowns as {
      dimension: string;
      total: number;
      top: { value: string; count: number; name?: string }[];
    }[];
    for (const breakdown of breakdowns) expect(breakdown.top.length).toBeLessThanOrEqual(8);
    const countries = breakdowns.find((b) => b.dimension === 'country');
    expect(countries?.top[0]?.name).toBe('United States');
    expect(report.countrySources).toBe('82% from Cloudflare, 18% from DB-IP');
    expect(report).not.toHaveProperty('hourOfWeek');
  });

  it('puts Unknown, Other and blanks last in every breakdown, still counted', async () => {
    const { deps: d } = deps({
      report: vi.fn(async ({ serverId: _s, ...request }) => ({
        ...new FakeTraffic({ now: () => NOW, userName: () => 'sam', sites: () => [] }).report(
          request,
        ),
        breakdowns: [
          {
            dimension: 'country' as const,
            total: 100,
            top: [
              { value: 'XX', count: 50 },
              { value: 'US', count: 30 },
              { value: 'Other', count: 15 },
              { value: 'DE', count: 5 },
            ],
          },
        ],
      })),
    });

    const report = await call(d, 'deploy.traffic', { serverId: 'srv-1', range: '7d' });

    const top = (report.breakdowns as { top: { value: string; count: number }[] }[])[0]?.top;
    expect(top?.map((item) => [item.value, item.count])).toEqual([
      ['US', 30],
      ['DE', 5],
      ['XX', 50],
      ['Other', 15],
    ]);
  });

  it('says there is no earlier data when the period before started before counting did', async () => {
    const { deps: d, fake } = deps();
    const report = fake.report({
      fromUnixMs: MIDNIGHT - 6 * DAY,
      toUnixMs: NOW,
      granularity: 'day',
      compare: true,
    });
    const starts = report.previousSeries?.map((point) => point.startUnixMs) ?? [];
    const { deps: partial } = deps({
      report: vi.fn(async () => ({ ...report, collectingSinceUnixMs: starts[3] })),
    });

    const counted = await call(d, 'deploy.traffic', { serverId: 'srv-1', range: '7d' });
    const answer = await call(partial, 'deploy.traffic', { serverId: 'srv-1', range: '7d' });

    expect(counted).toMatchObject({ noEarlierData: false });
    expect(counted.previous).toBeTruthy();
    expect(answer).toMatchObject({ noEarlierData: true, previous: null });
    const previous = answer.previousSeries as (object | null)[];
    expect(previous.slice(0, 3)).toEqual([null, null, null]);
    expect(previous[3]).toEqual({
      visitors: report.previousSeries?.[3]?.visitors,
      pageViews: report.previousSeries?.[3]?.pageViews,
    });
  });

  it('refuses a range, granularity or site it does not know, before the core hears of it', async () => {
    const { deps: d, traffic } = deps();

    for (const params of [
      { serverId: 'srv-1', range: 'forever' },
      { serverId: 'srv-1', range: '7d', granularity: 'minute' },
      { serverId: 'srv-1', range: '7d', siteId: 'Not A Site!' },
      { serverId: '../etc', range: '7d' },
    ]) {
      const error = await refused(call(d, 'deploy.traffic', params));
      expect(error.code).toBe('bad-params');
    }
    expect(traffic.report).not.toHaveBeenCalled();
  });

  it('turns an older core into words the phone can show', async () => {
    const { deps: d } = deps({
      status: vi.fn(async () => {
        throw new Error(OLDER_CORE);
      }),
    });

    const error = await refused(call(d, 'deploy.traffic', { serverId: 'srv-1', range: '7d' }));

    expect(error.code).toBe('failed');
    expect(error.message).toBe(OLDER_CORE);
  });

  it('pages a breakdown with the same checks as the computer, and names the countries', async () => {
    const { deps: d, traffic } = deps();

    const page = await call(d, 'deploy.trafficDimension', {
      serverId: 'srv-1',
      fromUnixMs: MIDNIGHT - 6 * DAY,
      toUnixMs: NOW,
      dimension: 'country',
      offset: 0,
    });

    expect(traffic.dimension).toHaveBeenCalledWith({
      serverId: 'srv-1',
      fromUnixMs: MIDNIGHT - 6 * DAY,
      toUnixMs: NOW,
      dimension: 'country',
      offset: 0,
      limit: 50,
    });
    const items = page.items as { value: string; name?: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.name).toBe('United States');
    const unknown = items.findIndex((item) => item.value === 'XX');
    if (unknown >= 0)
      expect(items.slice(unknown).every((item) => /^(XX|Other|)$/.test(item.value))).toBe(true);
    expect(page.totalItems).toBeGreaterThan(0);

    const error = await refused(
      call(d, 'deploy.trafficDimension', {
        serverId: 'srv-1',
        fromUnixMs: NOW,
        toUnixMs: NOW - DAY,
        dimension: 'country',
        offset: 0,
      }),
    );
    expect(error.message).toBe('The range must end after it starts.');
  });

  it('shows the settings the phone can change, and how auto-block stands', async () => {
    const { deps: d } = deps({}, 'Viewer');

    const status = await call(d, 'deploy.trafficStatus', { serverId: 'srv-1' });

    expect(status).toEqual({
      role: 'viewer',
      statistics: {
        enabled: true,
        countries: true,
        hourlyRetentionDays: 90,
        dailyRetentionDays: 730,
      },
      detection: { enabled: true },
      autoBlock: { enabled: false, kinds: ['scan', 'bruteForce'], minutes: 60 },
      geoDatabaseReady: true,
      storageBytes: 12_582_912,
      changedAt: null,
      changedBy: null,
    });
  });

  it('saves only what the phone changed and keeps the rest of the settings', async () => {
    const { deps: d, traffic, fake } = deps();
    fake.settings.excludedSites = ['shop'];
    fake.settings.timeZone = 'Europe/Berlin';
    fake.attackSettings.allowlist = ['10.0.0.0/8'];

    const done = await call(d, 'deploy.trafficSaveSettings', {
      serverId: 'srv-1',
      statistics: { enabled: false, countries: false, hourlyRetentionDays: 30 },
      detection: { enabled: false },
    });

    expect(done).toEqual({ ok: true, message: 'Saved.' });
    expect(traffic.saveSettings).toHaveBeenCalledWith({
      serverId: 'srv-1',
      settings: {
        enabled: false,
        countries: false,
        excludedSites: ['shop'],
        hourlyRetentionDays: 30,
        dailyRetentionDays: 730,
        timeZone: 'Europe/Berlin',
        readExistingLogs: false,
      },
    });
    expect(vi.mocked(traffic.saveAttackSettings).mock.calls[0]?.[0]).toMatchObject({
      serverId: 'srv-1',
      settings: { enabled: false, allowlist: ['10.0.0.0/8'], eventRetentionDays: 30 },
    });
  });

  it('says what is wrong with a setting in the form words, and saves nothing else', async () => {
    const { deps: d, traffic } = deps();

    const error = await refused(
      call(d, 'deploy.trafficSaveSettings', {
        serverId: 'srv-1',
        statistics: { hourlyRetentionDays: 2 },
      }),
    );

    expect(error.code).toBe('bad-params');
    expect(error.message).toMatch(/hourly/i);
    expect(traffic.saveAttackSettings).not.toHaveBeenCalled();

    const typed = await refused(
      call(d, 'deploy.trafficSaveSettings', { serverId: 'srv-1', detection: { enabled: 'yes' } }),
    );
    expect(typed.code).toBe('bad-params');
  });

  it('lists the attacks of the last week, short, with their kind and country in words', async () => {
    const { deps: d, traffic } = deps();

    const summary = await call(d, 'deploy.trafficAttacks', { serverId: 'srv-1', siteId: 'blog' });

    expect(traffic.attacks).toHaveBeenCalledWith({
      serverId: 'srv-1',
      siteId: 'blog',
      fromUnixMs: NOW - 7 * DAY,
      toUnixMs: NOW,
      limit: 50,
    });
    expect(summary).toMatchObject({ addresses: 4, blocked: 0 });
    const events = summary.events as Record<string, unknown>[];
    expect(events[0]).toEqual({
      id: 41,
      siteId: 'blog',
      kind: 'scan',
      kindLabel: 'Scans',
      address: '198.51.100.23',
      country: 'NL',
      countryName: 'Netherlands',
      firstSeen: NOW - 3 * 3_600_000,
      lastSeen: NOW - 2 * 60_000,
      count: 412,
      samplePaths: ['/.env', '/.git/config', '/wp-config.php.bak'],
      blocked: false,
    });
    expect(events[3]).toMatchObject({ country: null, countryName: null });
  });

  it('blocks an address only once the computer has checked it', async () => {
    const { deps: d, traffic } = deps();

    const done = await call(d, 'deploy.trafficBlock', {
      serverId: 'srv-1',
      network: ' 198.51.100.23 ',
      siteId: 'blog',
    });

    expect(done).toMatchObject({ ok: true });
    expect(String(done.message)).toContain('198.51.100.23');
    expect(traffic.block).toHaveBeenCalledWith({
      serverId: 'srv-1',
      network: ' 198.51.100.23 ',
      siteId: 'blog',
      reason: 'Blocked from the phone',
    });

    const error = await refused(
      call(d, 'deploy.trafficBlock', { serverId: 'srv-1', network: 'deny all; return 200' }),
    );
    expect(error.code).toBe('bad-params');
    expect(error.message).toMatch(/^That is not an address/);
  });

  it('lists the blocked addresses and lifts one', async () => {
    const { deps: d, traffic, fake } = deps();
    fake.block({ network: '203.0.113.45', reason: 'Password guessing' });

    const list = (await call(d, 'deploy.trafficBlocked', {
      serverId: 'srv-1',
    })) as unknown as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      network: '203.0.113.45',
      reason: 'Password guessing',
      automatic: false,
      expiresAt: null,
    });

    const done = await call(d, 'deploy.trafficUnblock', {
      serverId: 'srv-1',
      blockId: list[0]?.id,
    });
    expect(done).toEqual({ ok: true, message: 'Unblocked. nginx answers that address again.' });
    expect(traffic.unblock).toHaveBeenCalledWith({ serverId: 'srv-1', blockId: list[0]?.id });

    const error = await refused(
      call(d, 'deploy.trafficUnblock', { serverId: 'srv-1', blockId: -1 }),
    );
    expect(error.code).toBe('bad-params');
  });
});
