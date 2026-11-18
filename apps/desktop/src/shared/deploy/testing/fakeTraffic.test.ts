import { describe, expect, it } from 'vitest';
import { FakeTraffic, fakeTrafficReport, trafficBuckets } from './fakeTraffic';

/**
 * The pretend core's traffic side (E109, E110): reports that add up and stay the same for the same
 * request, paging behind "See all", settings checked like the core does, and blocking.
 */

const NOW = Date.UTC(2026, 10, 18, 14, 30);
const DAY = 86_400_000;

function traffic() {
  return new FakeTraffic({
    now: () => NOW,
    userName: () => 'maria',
    sites: () => [
      { siteId: 'blog', domains: ['blog.example.com'] },
      { siteId: 'shop', domains: ['shop.example.com', 'www.shop.example.com'] },
    ],
  });
}

describe('trafficBuckets', () => {
  it('cuts a range into hours, days, weeks from Monday and calendar months', () => {
    expect(trafficBuckets(Date.UTC(2026, 10, 18), Date.UTC(2026, 10, 18, 3), 'hour')).toHaveLength(
      3,
    );
    expect(trafficBuckets(Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 8), 'day')).toHaveLength(7);
    expect(trafficBuckets(Date.UTC(2026, 10, 18), Date.UTC(2026, 11, 1), 'week')[0]).toBe(
      Date.UTC(2026, 10, 16),
    );
    expect(trafficBuckets(Date.UTC(2026, 0, 15), Date.UTC(2026, 3, 2), 'month')).toEqual([
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 1, 1),
      Date.UTC(2026, 2, 1),
      Date.UTC(2026, 3, 1),
    ]);
  });
});

describe('fakeTrafficReport', () => {
  it('is the same for the same request and adds up', () => {
    const request = {
      fromUnixMs: NOW - 7 * DAY,
      toUnixMs: NOW,
      granularity: 'day' as const,
      compare: true,
    };
    const first = fakeTrafficReport(request);
    expect(fakeTrafficReport(request)).toEqual(first);
    expect(first.series).toHaveLength(8);
    expect(first.totals.pageViews).toBe(
      first.series.reduce((sum, point) => sum + point.pageViews, 0),
    );
    expect(first.totals.visits).toBeLessThanOrEqual(first.totals.pageViews);
    expect(first.totals.visitors).toBeLessThanOrEqual(first.totals.visits);
    expect(first.hourOfWeek).toHaveLength(168);
    expect(first.previous?.pageViews).toBeLessThan(first.totals.pageViews);
    expect(first.previousSeries).toHaveLength(first.series.length);
    const countries = first.breakdowns.find((item) => item.dimension === 'country');
    expect(countries?.top[0]).toEqual({ value: 'US', count: expect.any(Number) });
    expect(countries?.total).toBe(first.totals.pageViews);
  });

  it('leaves the comparison out when not asked, and is empty when told', () => {
    const report = fakeTrafficReport(
      { fromUnixMs: NOW - DAY, toUnixMs: NOW, granularity: 'hour', compare: false },
      { empty: true },
    );
    expect(report.previous).toBeUndefined();
    expect(report.totals.pageViews).toBe(0);
    expect(report.breakdowns.every((item) => item.top.length === 0)).toBe(true);
  });
});

describe('FakeTraffic', () => {
  it('lists the sites and starts with statistics off', () => {
    const fake = traffic();
    const status = fake.status();
    expect(status.settings.enabled).toBe(false);
    expect(status.sites.map((site) => site.siteId)).toEqual(['blog', 'shop']);
    expect(status.autoBlock.enabled).toBe(false);
  });

  it('saves good settings and refuses bad ones without saving', () => {
    const fake = traffic();
    const good = { ...fake.status().settings, enabled: true, excludedSites: ['shop'] };
    const saved = fake.saveSettings(good);
    expect(saved.problems).toEqual([]);
    expect(saved.status?.settings.enabled).toBe(true);
    expect(saved.status?.sites.find((site) => site.siteId === 'shop')?.excluded).toBe(true);
    expect(saved.status?.changedBy).toBe('maria');

    const bad = fake.saveSettings({ ...good, hourlyRetentionDays: 1 });
    expect(bad.problems).toEqual(['Keep hourly figures for 7 to 365 days.']);
    expect(fake.status().settings.hourlyRetentionDays).toBe(90);
  });

  it('pages a dimension and searches it', () => {
    const fake = traffic();
    const page = fake.dimension({
      fromUnixMs: NOW - 7 * DAY,
      toUnixMs: NOW,
      dimension: 'page',
      offset: 0,
      limit: 10,
    });
    expect(page.items).toHaveLength(10);
    expect(page.totalItems).toBeGreaterThan(50);
    const search = fake.dimension({
      fromUnixMs: NOW - 7 * DAY,
      toUnixMs: NOW,
      dimension: 'page',
      offset: 0,
      limit: 100,
      search: 'pricing',
    });
    expect(search.items.map((item) => item.value)).toEqual(['/pricing']);
  });

  it('blocks an address once, lists it, and lets it back', () => {
    const fake = traffic();
    expect(fake.block({ network: 'nope' }).problems).toHaveLength(1);
    const blocked = fake.block({ network: '198.51.100.23', minutes: 60, reason: 'Scan' });
    expect(blocked.problems).toEqual([]);
    expect(blocked.blocked).toMatchObject({
      network: '198.51.100.23',
      createdBy: 'maria',
      expiresAtUnixMs: NOW + 3_600_000,
    });
    expect(fake.block({ network: '198.51.100.23' }).problems).toEqual([
      '198.51.100.23 is already blocked.',
    ]);
    expect(
      fake.attacks({ limit: 200 }).events.find((e) => e.address === '198.51.100.23')?.blocked,
    ).toBe(true);
    fake.unblock(blocked.blocked?.id ?? 0);
    expect(fake.blocked()).toEqual([]);
    expect(() => fake.unblock(999)).toThrow('That address is not blocked any more.');
  });

  it('keeps attack settings and auto-block apart, checking each', () => {
    const fake = traffic();
    expect(
      fake.saveAutoBlock({ enabled: true, kinds: [], minutes: 60, maxBlocked: 10 }).problems,
    ).toEqual(['Pick at least one kind of attack to block.']);
    expect(
      fake.saveAutoBlock({ enabled: true, kinds: ['scan'], minutes: 60, maxBlocked: 10 }).status
        ?.autoBlock.enabled,
    ).toBe(true);
    const attacks = fake.status().attacks;
    expect(fake.saveAttackSettings({ ...attacks, eventRetentionDays: 3 }).problems).toHaveLength(1);
    expect(fake.saveAttackSettings({ ...attacks, enabled: false }).status?.attacks.enabled).toBe(
      false,
    );
  });

  it('forgets one site or every site', () => {
    const fake = traffic();
    fake.deleteData('blog');
    expect(fake.deleted).toEqual(['blog']);
    fake.deleteData(null);
    expect(fake.deleted).toEqual(['blog', '*']);
    expect(
      fake.report({ fromUnixMs: NOW - DAY, toUnixMs: NOW, granularity: 'hour', compare: false })
        .totals.pageViews,
    ).toBe(0);
  });
});
