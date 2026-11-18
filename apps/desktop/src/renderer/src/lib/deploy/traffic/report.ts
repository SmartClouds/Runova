import type {
  TrafficBreakdown,
  TrafficDimension,
  TrafficPoint,
  TrafficReport,
  TrafficTotals,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { comparison } from '@shared/deploy/trafficCompare';
import {
  botShare,
  bounceRate,
  changeOf,
  compactNumber,
  formatBytes,
  formatDuration,
  formatShare,
  pagesPerVisit,
  type TrafficChange,
  visitLength,
} from '@shared/deploy/trafficFormat';

// Shared with the phone's bridge (E111), so both read the same.
export {
  type Comparison,
  catchAllsLast,
  comparison,
  previousLine,
} from '@shared/deploy/trafficCompare';

/**
 * The figures the traffic report's tiles and cards read from a report (E109): each tile's value,
 * how it moved since the period before (and whether that is good), and its trend where the series
 * holds one. Labels live with the components; this is the arithmetic.
 */

export const KPI_KEYS = [
  'visitors',
  'visits',
  'pageViews',
  'bounceRate',
  'pagesPerVisit',
  'visitLength',
  'bandwidth',
  'botShare',
] as const;

export type KpiKey = (typeof KPI_KEYS)[number];

export interface KpiFigure {
  key: KpiKey;
  value: string;
  change: TrafficChange | null;
  /** Whether a rise is good news: more visitors is, a higher bounce rate is not; null for neither. */
  goodWhenUp: boolean | null;
  /** The figure per bucket, for the tile's sparkline; null when the series cannot say. */
  spark: number[] | null;
  /** A comparison was asked for, but the period before has no figures to compare with. */
  noEarlierData: boolean;
}

interface KpiSpec {
  key: KpiKey;
  goodWhenUp: boolean | null;
  of: (totals: TrafficTotals) => number;
  format: (value: number) => string;
  spark: ((point: TrafficPoint) => number) | null;
}

const ratio = (top: number, bottom: number) => (bottom > 0 ? top / bottom : 0);

const SPECS: readonly KpiSpec[] = [
  {
    key: 'visitors',
    goodWhenUp: true,
    of: (t) => t.visitors,
    format: compactNumber,
    spark: (p) => p.visitors,
  },
  {
    key: 'visits',
    goodWhenUp: true,
    of: (t) => t.visits,
    format: compactNumber,
    spark: (p) => p.visits,
  },
  {
    key: 'pageViews',
    goodWhenUp: true,
    of: (t) => t.pageViews,
    format: compactNumber,
    spark: (p) => p.pageViews,
  },
  { key: 'bounceRate', goodWhenUp: false, of: bounceRate, format: formatShare, spark: null },
  {
    key: 'pagesPerVisit',
    goodWhenUp: true,
    of: pagesPerVisit,
    format: (value) => value.toFixed(1),
    spark: (p) => ratio(p.pageViews, p.visits),
  },
  { key: 'visitLength', goodWhenUp: true, of: visitLength, format: formatDuration, spark: null },
  {
    key: 'bandwidth',
    // More bandwidth is neither good nor bad news; it reads as neutral either way.
    goodWhenUp: null,
    of: (t) => t.bytes,
    format: formatBytes,
    spark: (p) => p.bytes,
  },
  {
    key: 'botShare',
    goodWhenUp: false,
    of: botShare,
    format: formatShare,
    spark: (p) => ratio(p.botRequests, p.requests),
  },
];

export function kpiFigures(report: TrafficReport): KpiFigure[] {
  const compared = comparison(report);
  const previous = compared.changes ? report.previous : undefined;
  return SPECS.map((spec) => {
    const current = spec.of(report.totals);
    return {
      key: spec.key,
      value: spec.format(current),
      change: previous ? changeOf(current, spec.of(previous)) : null,
      noEarlierData: compared.reason === 'noData',
      goodWhenUp: spec.goodWhenUp,
      spark: spec.spark ? report.series.map(spec.spark) : null,
    };
  });
}

export type ChangeTone = 'good' | 'bad' | 'neutral';

export function changeTone(change: TrafficChange | null, goodWhenUp: boolean | null): ChangeTone {
  if (!change || change.direction === 'flat' || goodWhenUp === null) return 'neutral';
  return (change.direction === 'up') === goodWhenUp ? 'good' : 'bad';
}

export function breakdownOf(report: TrafficReport, dimension: TrafficDimension): TrafficBreakdown {
  return (
    report.breakdowns.find((breakdown) => breakdown.dimension === dimension) ?? {
      dimension,
      top: [],
      total: 0,
    }
  );
}

/** Each bucket as [answered (2xx and 3xx), client errors (4xx), server errors (5xx)]. */
export function statusColumns(series: readonly TrafficPoint[]): number[][] {
  return series.map((point) => [
    Math.max(0, point.requests - point.status4xx - point.status5xx),
    point.status4xx,
    point.status5xx,
  ]);
}
