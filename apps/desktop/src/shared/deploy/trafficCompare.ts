import type {
  TrafficDimension,
  TrafficReport,
} from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * Two rules of the traffic report (E109) that the desktop and the phone's bridge (E111) share:
 * catch-all values sort to the bottom of a breakdown, and the period before is compared only where
 * statistics were counted.
 */

/** Values that stand for many: unknown places, the fold past the values kept, nothing at all. */
const CATCH_ALLS = new Set(['other', 'unknown', '(none)', '']);

function isCatchAll(dimension: TrafficDimension, value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    CATCH_ALLS.has(lower) || ((dimension === 'country' || dimension === 'city') && lower === 'xx')
  );
}

/**
 * A breakdown's values with the catch-alls (Unknown, Other, blank) at the bottom, so a big
 * "Unknown" never leads the list. They keep their counts and shares; Tor ranks like any country.
 */
export function catchAllsLast<T extends { value: string }>(
  items: readonly T[],
  dimension: TrafficDimension,
): T[] {
  return [
    ...items.filter((item) => !isCatchAll(dimension, item.value)),
    ...items.filter((item) => isCatchAll(dimension, item.value)),
  ];
}

export interface Comparison {
  /** Whether the tiles may say how each figure moved. */
  changes: boolean;
  /** The first bucket of the period before that was counted, or null to draw none of it. */
  firstPrevious: number | null;
  /** Why there are no changes: nothing was asked for, or the period before was not counted (in full). */
  reason?: 'none' | 'noData';
}

/**
 * What the comparison with the period before can honestly show. Statistics count from when they
 * were turned on, so a period before that started earlier holds only part of the truth: a change
 * against it would read like +5,000%. Then the tiles say there is no earlier data, and the dashed
 * line is drawn only for the buckets that were counted.
 */
export function comparison(report: TrafficReport): Comparison {
  const previous = report.previous;
  const series = report.previousSeries;
  if (!previous || !series) return { changes: false, firstPrevious: null, reason: 'none' };
  const empty = previous.requests === 0 && previous.pageViews === 0;
  const since = report.collectingSinceUnixMs;
  const previousFrom = report.fromUnixMs - (report.toUnixMs - report.fromUnixMs);
  const first = since === undefined ? 0 : series.findIndex((point) => point.startUnixMs >= since);
  const firstPrevious = empty || first < 0 ? null : first;
  if (empty || (since !== undefined && since > previousFrom)) {
    return { changes: false, firstPrevious, reason: 'noData' };
  }
  return { changes: true, firstPrevious };
}

/** The period before's values with the buckets that were not counted left out (null). */
export function previousLine(
  values: readonly number[],
  firstPrevious: number | null,
): (number | null)[] | null {
  if (firstPrevious === null) return null;
  return values.map((value, index) => (index < firstPrevious ? null : value));
}
