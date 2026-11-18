import { describe, expect, it } from 'vitest';
import { fakeTrafficReport } from './testing/fakeTraffic';
import { catchAllsLast, comparison, previousLine } from './trafficCompare';

/**
 * The rules the desktop's report and the phone's bridge share (E109, E111): catch-alls sort last,
 * and the period before is compared only where statistics were counted.
 */

const NOW = Date.UTC(2026, 10, 18, 14, 30);
const DAY = 86_400_000;
const REPORT = fakeTrafficReport({
  fromUnixMs: NOW - 7 * DAY,
  toUnixMs: NOW,
  granularity: 'day',
  compare: true,
});

describe('catchAllsLast', () => {
  it('moves Unknown, Other and blanks to the bottom, keeping the rest in order', () => {
    const items = [
      { value: 'XX', count: 90 },
      { value: 'US', count: 80 },
      { value: 'Other', count: 50 },
      { value: 'T1', count: 40 },
      { value: 'DE', count: 30 },
      { value: '', count: 5 },
    ];
    expect(catchAllsLast(items, 'country').map((item) => item.value)).toEqual([
      'US',
      'T1',
      'DE',
      'XX',
      'Other',
      '',
    ]);
    expect(
      catchAllsLast(
        [
          { value: 'Unknown', count: 9 },
          { value: 'Chrome', count: 3 },
        ],
        'browser',
      ).map((item) => item.value),
    ).toEqual(['Chrome', 'Unknown']);
  });

  it('keeps XX as a value outside countries', () => {
    const items = [
      { value: 'XX', count: 9 },
      { value: '/a', count: 3 },
    ];
    expect(catchAllsLast(items, 'page')).toEqual(items);
  });
});

describe('comparison', () => {
  it('compares when the period before was counted in full', () => {
    expect(comparison(REPORT)).toEqual({ changes: true, firstPrevious: 0 });
  });

  it('has nothing to compare without a period before or with an empty one', () => {
    const { previous: _, previousSeries: __, ...alone } = REPORT;
    expect(comparison(alone)).toEqual({ changes: false, firstPrevious: null, reason: 'none' });
    const empty = {
      ...REPORT,
      previous: { ...REPORT.totals, requests: 0, pageViews: 0, visits: 0, visitors: 0 },
    };
    expect(comparison(empty)).toEqual({ changes: false, firstPrevious: null, reason: 'noData' });
  });

  it('draws the period before only from when statistics were on, without changes', () => {
    const previousStarts = REPORT.previousSeries?.map((point) => point.startUnixMs) ?? [];
    const partial = { ...REPORT, collectingSinceUnixMs: previousStarts[3] };
    expect(comparison(partial)).toEqual({ changes: false, firstPrevious: 3, reason: 'noData' });
    const none = { ...REPORT, collectingSinceUnixMs: REPORT.fromUnixMs + DAY };
    expect(comparison(none)).toEqual({ changes: false, firstPrevious: null, reason: 'noData' });
  });
});

describe('previousLine', () => {
  it('blanks the buckets of the period before that were not counted', () => {
    expect(previousLine([1, 2, 3, 4], 2)).toEqual([null, null, 3, 4]);
    expect(previousLine([1, 2], null)).toBeNull();
    expect(previousLine([1, 2], 0)).toEqual([1, 2]);
  });
});
