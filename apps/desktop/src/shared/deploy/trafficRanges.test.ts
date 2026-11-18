import { describe, expect, it } from 'vitest';
import {
  axisLabel,
  bucketLabel,
  customRangeProblem,
  DAY_MS,
  dateInZone,
  defaultGranularity,
  fitGranularity,
  granularityChoices,
  previousWindow,
  RANGE_OPTIONS,
  rangeWindow,
  startOfDayIn,
} from './trafficRanges';

// Wednesday 18 November 2026, 14:30 UTC.
const NOW = Date.UTC(2026, 10, 18, 14, 30);
const HOUR = 3_600_000;

describe('startOfDayIn', () => {
  it('finds midnight in the report time zone', () => {
    expect(startOfDayIn(NOW, 'UTC')).toBe(Date.UTC(2026, 10, 18));
    // Tehran is UTC+3:30 all year.
    expect(startOfDayIn(NOW, 'Asia/Tehran')).toBe(Date.UTC(2026, 10, 17, 20, 30));
    // 01:00 UTC is still the day before in New York (UTC-5 in November).
    expect(startOfDayIn(Date.UTC(2026, 10, 18, 1), 'America/New_York')).toBe(
      Date.UTC(2026, 10, 17, 5),
    );
  });

  it('copes with a day that starts on a clock change', () => {
    // Europe/Berlin moves to summer time at 02:00 on 29 March 2026; midnight is still UTC+1.
    expect(startOfDayIn(Date.UTC(2026, 2, 29, 12), 'Europe/Berlin')).toBe(
      Date.UTC(2026, 2, 28, 23),
    );
  });

  it('falls back to UTC for a zone it does not know', () => {
    expect(startOfDayIn(NOW, 'Not/AZone')).toBe(Date.UTC(2026, 10, 18));
  });
});

describe('dateInZone', () => {
  it('writes the calendar date as the date field wants it', () => {
    expect(dateInZone(NOW, 'UTC')).toBe('2026-11-18');
    expect(dateInZone(Date.UTC(2026, 10, 18, 22), 'Asia/Tehran')).toBe('2026-11-19');
  });
});

describe('rangeWindow', () => {
  it('starts each preset at a midnight and ends now', () => {
    const today = Date.UTC(2026, 10, 18);
    expect(rangeWindow('today', NOW, 'UTC')).toEqual({ from: today, to: NOW });
    expect(rangeWindow('7d', NOW, 'UTC')).toEqual({ from: today - 6 * DAY_MS, to: NOW });
    expect(rangeWindow('30d', NOW, 'UTC')).toEqual({ from: today - 29 * DAY_MS, to: NOW });
    expect(rangeWindow('90d', NOW, 'UTC')).toEqual({ from: today - 89 * DAY_MS, to: NOW });
    expect(rangeWindow('12m', NOW, 'UTC')).toEqual({ from: today - 364 * DAY_MS, to: NOW });
  });

  it('takes a custom range as whole days, the last one included', () => {
    expect(rangeWindow('custom', NOW, 'UTC', { from: '2026-11-01', to: '2026-11-03' })).toEqual({
      from: Date.UTC(2026, 10, 1),
      to: Date.UTC(2026, 10, 4),
    });
  });

  it('ends a custom range that reaches today at now', () => {
    expect(rangeWindow('custom', NOW, 'UTC', { from: '2026-11-17', to: '2026-11-18' })).toEqual({
      from: Date.UTC(2026, 10, 17),
      to: NOW,
    });
  });

  it('treats a custom range without dates as the last 7 days', () => {
    expect(rangeWindow('custom', NOW, 'UTC')).toEqual(rangeWindow('7d', NOW, 'UTC'));
  });

  it('offers every preset with a label', () => {
    expect(RANGE_OPTIONS.map((option) => option.label)).toEqual([
      'Today',
      '7 days',
      '30 days',
      '90 days',
      '12 months',
      'Custom',
    ]);
  });
});

describe('previousWindow', () => {
  it('is the same length just before', () => {
    expect(previousWindow({ from: 1000, to: 1600 })).toEqual({ from: 400, to: 1000 });
  });
});

describe('customRangeProblem', () => {
  it('accepts a sensible range and says what is wrong with others', () => {
    expect(customRangeProblem('2026-11-01', '2026-11-03', NOW, 'UTC')).toBeNull();
    expect(customRangeProblem('', '2026-11-03', NOW, 'UTC')).toBe('Pick a first and a last day.');
    expect(customRangeProblem('2026-11-05', '2026-11-03', NOW, 'UTC')).toBe(
      'The first day comes after the last.',
    );
    expect(customRangeProblem('2026-11-01', '2026-11-30', NOW, 'UTC')).toBe(
      'The last day is in the future.',
    );
    expect(customRangeProblem('2023-01-01', '2026-11-03', NOW, 'UTC')).toBe(
      'Pick at most three years.',
    );
    expect(customRangeProblem('2023-11-04', '2026-11-03', NOW, 'UTC')).toBeNull();
    expect(customRangeProblem('2026-02-31', '2026-11-03', NOW, 'UTC')).toBe(
      'Pick a first and a last day.',
    );
  });
});

describe('defaultGranularity', () => {
  it('picks hours for a day, days for a month and months for a year', () => {
    expect(defaultGranularity('today', DAY_MS)).toBe('hour');
    expect(defaultGranularity('7d', 7 * DAY_MS)).toBe('day');
    expect(defaultGranularity('30d', 30 * DAY_MS)).toBe('day');
    expect(defaultGranularity('90d', 90 * DAY_MS)).toBe('week');
    expect(defaultGranularity('12m', 365 * DAY_MS)).toBe('month');
  });

  it('follows the length of a custom range', () => {
    expect(defaultGranularity('custom', 2 * DAY_MS)).toBe('hour');
    expect(defaultGranularity('custom', 60 * DAY_MS)).toBe('day');
    expect(defaultGranularity('custom', 300 * DAY_MS)).toBe('week');
    expect(defaultGranularity('custom', 800 * DAY_MS)).toBe('month');
  });
});

describe('granularityChoices', () => {
  it('allows hours only over a short range within the hourly retention', () => {
    const week = { from: NOW - 7 * DAY_MS, to: NOW };
    const choices = granularityChoices(week, NOW, 90);
    expect(choices.map((choice) => [choice.value, choice.enabled])).toEqual([
      ['hour', true],
      ['day', true],
      ['week', false],
      ['month', false],
    ]);

    const old = granularityChoices({ from: NOW - 100 * DAY_MS, to: NOW - 98 * DAY_MS }, NOW, 90);
    expect(old[0]).toMatchObject({ value: 'hour', enabled: false });
    expect(old[0].reason).toBe('Hourly figures are kept for 90 days.');

    const long = granularityChoices({ from: NOW - 30 * DAY_MS, to: NOW }, NOW, 90);
    expect(long[0]).toMatchObject({ value: 'hour', enabled: false });
    expect(long[0].reason).toBe('Pick 14 days or fewer to see hours.');
  });

  it('offers weeks and months once the range holds a few of them', () => {
    const year = granularityChoices({ from: NOW - 365 * DAY_MS, to: NOW }, NOW, 90);
    expect(year.map((choice) => choice.enabled)).toEqual([false, true, true, true]);
    const fiveYears = granularityChoices({ from: NOW - 1800 * DAY_MS, to: NOW }, NOW, 90);
    expect(fiveYears.find((choice) => choice.value === 'day')?.enabled).toBe(false);
  });
});

describe('fitGranularity', () => {
  it('keeps a choice that is allowed and moves off one that is not', () => {
    const week = granularityChoices({ from: NOW - 7 * DAY_MS, to: NOW }, NOW, 90);
    expect(fitGranularity('hour', week, 'day')).toBe('hour');
    expect(fitGranularity('month', week, 'day')).toBe('day');
    expect(fitGranularity('month', week, 'week')).toBe('hour');
  });
});

describe('bucketLabel and axisLabel', () => {
  it('names a bucket the way its size reads', () => {
    expect(bucketLabel(Date.UTC(2026, 10, 18, 14), 'hour', 'UTC')).toBe('Wed 18 Nov, 14:00');
    expect(bucketLabel(Date.UTC(2026, 10, 18), 'day', 'UTC')).toBe('Wed 18 Nov 2026');
    expect(bucketLabel(Date.UTC(2026, 10, 16), 'week', 'UTC')).toBe('Week of 16 Nov 2026');
    expect(bucketLabel(Date.UTC(2026, 10, 1), 'month', 'UTC')).toBe('November 2026');
  });

  it('keeps the axis short', () => {
    expect(axisLabel(Date.UTC(2026, 10, 18, 14), 'hour', 'UTC')).toBe('14:00');
    expect(axisLabel(Date.UTC(2026, 10, 18), 'day', 'UTC')).toBe('18 Nov');
    expect(axisLabel(Date.UTC(2026, 10, 16), 'week', 'UTC')).toBe('16 Nov');
    expect(axisLabel(Date.UTC(2026, 10, 1), 'month', 'UTC')).toBe('Nov 2026');
  });

  it('reads the hour in the report time zone', () => {
    expect(axisLabel(Date.UTC(2026, 10, 18, 14), 'hour', 'Asia/Tehran')).toBe('17:30');
    expect(HOUR).toBe(3_600_000);
  });
});
