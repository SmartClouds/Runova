import type {
  TrafficCountrySources,
  TrafficTotals,
} from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * How the traffic report (E109) writes its numbers, shared by the desktop and the phone bridge:
 * counts in full under 10,000 and short above (12.9K), bytes in the unit that keeps them short,
 * durations as people say them, and the figures worked out from the totals. Nothing here divides
 * by zero: a range with no visits reads 0 rather than NaN.
 */

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const SHORT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
/** A change smaller than this reads as no change at all. */
const FLAT = 0.005;

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  return Math.abs(rounded) < 10_000 ? GROUPED.format(rounded) : SHORT.format(rounded);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${BYTE_UNITS[unit]}`;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) {
    return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}m`;
}

export function formatMs(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A share from 0 to 1 as a percentage, with a decimal only under 10%. */
export function formatShare(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const percent = ratio * 100;
  return percent < 10
    ? `${Number(percent.toFixed(1))}%`
    : `${GROUPED.format(Math.round(percent))}%`;
}

export function bounceRate(totals: TrafficTotals): number {
  return totals.visits > 0 ? totals.bounces / totals.visits : 0;
}

export function pagesPerVisit(totals: TrafficTotals): number {
  return totals.visits > 0 ? totals.pageViews / totals.visits : 0;
}

/** The average visit, in seconds. */
export function visitLength(totals: TrafficTotals): number {
  return totals.visits > 0 ? totals.visitSeconds / totals.visits : 0;
}

/** The share of requests that came from bots. */
export function botShare(totals: TrafficTotals): number {
  return totals.requests > 0 ? totals.botRequests / totals.requests : 0;
}

export interface TrafficChange {
  direction: 'up' | 'down' | 'flat';
  /** The change as a share of the period before; null when that period had none. */
  ratio: number | null;
}

/** How a figure moved since the period before, or null when there is no period before. */
export function changeOf(current: number, previous: number | undefined): TrafficChange | null {
  if (previous === undefined || !Number.isFinite(previous)) return null;
  if (previous === 0)
    return current > 0 ? { direction: 'up', ratio: null } : { direction: 'flat', ratio: 0 };
  const ratio = (current - previous) / previous;
  const direction = Math.abs(ratio) < FLAT ? 'flat' : ratio > 0 ? 'up' : 'down';
  return { direction, ratio };
}

export function changeText(change: TrafficChange): string {
  if (change.ratio === null) return 'New';
  if (change.direction === 'flat') return 'No change';
  const share = formatShare(Math.abs(change.ratio));
  return `${change.ratio > 0 ? '+' : '-'}${share}`;
}

const REGIONS = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** A country's name from its ISO code. The core writes XX and T1 as Unknown and Tor. */
export function countryName(code: string): string {
  const upper = code.toUpperCase();
  if (upper === 'XX' || upper === 'UNKNOWN' || upper === '') return 'Unknown';
  if (upper === 'T1' || upper === 'TOR') return 'Tor';
  if (!/^[A-Z]{2}$/.test(upper)) return code;
  try {
    return REGIONS.of(upper) ?? code;
  } catch {
    return code;
  }
}

/** "82% from Cloudflare, 18% from DB-IP", or null when no page view had a country yet. */
export function sourcesText(sources: TrafficCountrySources): string | null {
  const total = sources.cloudflare + sources.dbIp + sources.unknown;
  if (total <= 0) return null;
  const parts: string[] = [];
  if (sources.cloudflare > 0)
    parts.push(`${formatShare(sources.cloudflare / total)} from Cloudflare`);
  if (sources.dbIp > 0) parts.push(`${formatShare(sources.dbIp / total)} from DB-IP`);
  if (sources.unknown > 0) parts.push(`${formatShare(sources.unknown / total)} unknown`);
  return parts.join(', ');
}
