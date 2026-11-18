import { fakeTrafficReport } from '@shared/deploy/testing/fakeTraffic';
import { describe, expect, it } from 'vitest';
import { breakdownOf, changeTone, KPI_KEYS, kpiFigures, statusColumns } from './report';

const NOW = Date.UTC(2026, 10, 18, 14, 30);
const DAY = 86_400_000;
const REPORT = fakeTrafficReport({
  fromUnixMs: NOW - 7 * DAY,
  toUnixMs: NOW,
  granularity: 'day',
  compare: true,
});

describe('kpiFigures', () => {
  it('gives every tile a value, its change and a trend where the series has one', () => {
    const figures = kpiFigures(REPORT);
    expect(figures.map((figure) => figure.key)).toEqual([...KPI_KEYS]);
    const visitors = figures[0];
    expect(visitors.value).toMatch(/^[\d,.]+K?$/);
    expect(visitors.change?.direction).toBe('up');
    expect(visitors.spark).toHaveLength(REPORT.series.length);

    const bounce = figures.find((figure) => figure.key === 'bounceRate');
    expect(bounce).toMatchObject({ value: '42%', goodWhenUp: false, spark: null });
    expect(figures.find((figure) => figure.key === 'visitLength')?.value).toBe('2m 14s');
    expect(figures.find((figure) => figure.key === 'bandwidth')?.value).toMatch(/GB|MB/);
    expect(figures.find((figure) => figure.key === 'botShare')?.value).toBe('22%');
    expect(figures.find((figure) => figure.key === 'pagesPerVisit')?.value).toBe('2.9');
  });

  it('has no change without a period before', () => {
    const { previous: _, previousSeries: __, ...alone } = REPORT;
    expect(kpiFigures(alone).every((figure) => figure.change === null)).toBe(true);
  });
});

describe('changeTone', () => {
  it('is good or bad by direction and by whether up is good', () => {
    expect(changeTone({ direction: 'up', ratio: 0.1 }, true)).toBe('good');
    expect(changeTone({ direction: 'up', ratio: 0.1 }, false)).toBe('bad');
    expect(changeTone({ direction: 'down', ratio: -0.1 }, false)).toBe('good');
    expect(changeTone({ direction: 'flat', ratio: 0 }, true)).toBe('neutral');
    expect(changeTone(null, true)).toBe('neutral');
    expect(changeTone({ direction: 'up', ratio: 0.5 }, null)).toBe('neutral');
  });
});

describe('breakdownOf', () => {
  it('finds a dimension, or an empty one when the report has none', () => {
    expect(breakdownOf(REPORT, 'browser').top[0].value).toBe('Chrome');
    expect(breakdownOf({ ...REPORT, breakdowns: [] }, 'city')).toEqual({
      dimension: 'city',
      top: [],
      total: 0,
    });
  });
});

describe('statusColumns', () => {
  it('splits each bucket into answered, client errors and server errors', () => {
    const columns = statusColumns([
      {
        startUnixMs: 0,
        visitors: 0,
        visits: 0,
        pageViews: 0,
        requests: 100,
        botRequests: 0,
        bytes: 0,
        status4xx: 7,
        status5xx: 3,
      },
    ]);
    expect(columns).toEqual([[90, 7, 3]]);
  });
});

describe('kpiFigures with no earlier data', () => {
  it('leaves the changes out of the tiles and says why', () => {
    const partial = { ...REPORT, collectingSinceUnixMs: REPORT.fromUnixMs - DAY };
    const figures = kpiFigures(partial);
    expect(figures.every((figure) => figure.change === null && figure.noEarlierData)).toBe(true);
    expect(kpiFigures(REPORT).some((figure) => figure.noEarlierData)).toBe(false);
  });
});
