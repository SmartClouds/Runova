import type { TrafficGranularity } from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * The traffic report's ranges and buckets (E109). Days, weeks and months follow the report's time
 * zone, the one the core keeps its daily rows in, so "Today" starts at that zone's midnight wherever
 * this computer is. Hours exist only within the hourly retention, and only a short range is worth
 * reading by the hour.
 */

export const DAY_MS = 86_400_000;
const MAX_HOURLY_SPAN = 14 * DAY_MS;
const MAX_DAILY_SPAN = 400 * DAY_MS;
const MIN_WEEKLY_SPAN = 28 * DAY_MS;
const MIN_MONTHLY_SPAN = 60 * DAY_MS;
/** The core reports on at most three years at a time. */
const MAX_CUSTOM_SPAN = 3 * 365 * DAY_MS;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export type TrafficRange = 'today' | '7d' | '30d' | '90d' | '12m' | 'custom';

export const RANGE_OPTIONS: ReadonlyArray<{ value: TrafficRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '12m', label: '12 months' },
  { value: 'custom', label: 'Custom' },
];

export const GRANULARITY_OPTIONS: ReadonlyArray<{ value: TrafficGranularity; label: string }> = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

/** Days back from today's midnight where each preset starts. */
const PRESET_DAYS: Record<Exclude<TrafficRange, 'custom' | 'today'>, number> = {
  '7d': 6,
  '30d': 29,
  '90d': 89,
  '12m': 364,
};

export interface TrafficWindow {
  /** Inclusive. */
  from: number;
  /** Exclusive. */
  to: number;
}

/** A custom range as the date fields hold it: YYYY-MM-DD, both days included. */
export interface CustomDays {
  from: string;
  to: string;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  monthName: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    try {
      found = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      found = formatter('UTC');
    }
    formatters.set(timeZone, found);
  }
  return found;
}

function partsIn(ms: number, timeZone: string): Parts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(ms)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: MONTHS.indexOf(parts.month) + 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
    monthName: parts.month,
  };
}

/** How far the zone's clock is ahead of UTC at a moment. */
function offsetAt(ms: number, timeZone: string): number {
  const p = partsIn(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The moment a calendar day starts in the zone. */
function midnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

export function startOfDayIn(ms: number, timeZone: string): number {
  const p = partsIn(ms, timeZone);
  return midnight(p.year, p.month, p.day, timeZone);
}

/** The calendar day of a moment in the zone, as YYYY-MM-DD. */
export function dateInZone(ms: number, timeZone: string): string {
  const p = partsIn(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseDay(text: string): { year: number; month: number; day: number } | null {
  const match = DATE.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) return null;
  if (check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function rangeWindow(
  range: TrafficRange,
  now: number,
  timeZone: string,
  custom?: CustomDays,
): TrafficWindow {
  const today = startOfDayIn(now, timeZone);
  if (range === 'today') return { from: today, to: now };
  if (range === 'custom') {
    const first = custom ? parseDay(custom.from) : null;
    const last = custom ? parseDay(custom.to) : null;
    if (!first || !last) return rangeWindow('7d', now, timeZone);
    const from = midnight(first.year, first.month, first.day, timeZone);
    // The day after the last one, counted on the calendar so a clock change cannot shift it.
    const after = new Date(Date.UTC(last.year, last.month - 1, last.day + 1));
    const end = midnight(
      after.getUTCFullYear(),
      after.getUTCMonth() + 1,
      after.getUTCDate(),
      timeZone,
    );
    return { from, to: Math.min(end, now) };
  }
  return { from: today - PRESET_DAYS[range] * DAY_MS, to: now };
}

/** The period of the same length just before, for the comparison. */
export function previousWindow(window: TrafficWindow): TrafficWindow {
  return { from: window.from - (window.to - window.from), to: window.from };
}

/** Why a custom range cannot be shown, or null when it can. */
export function customRangeProblem(
  from: string,
  to: string,
  now: number,
  timeZone: string,
): string | null {
  const first = parseDay(from);
  const last = parseDay(to);
  if (!first || !last) return 'Pick a first and a last day.';
  if (from > to) return 'The first day comes after the last.';
  if (to > dateInZone(now, timeZone)) return 'The last day is in the future.';
  const span =
    Date.UTC(last.year, last.month - 1, last.day) -
    Date.UTC(first.year, first.month - 1, first.day);
  if (span > MAX_CUSTOM_SPAN) return 'Pick at most three years.';
  return null;
}

export function defaultGranularity(range: TrafficRange, spanMs: number): TrafficGranularity {
  switch (range) {
    case 'today':
      return 'hour';
    case '7d':
    case '30d':
      return 'day';
    case '90d':
      return 'week';
    case '12m':
      return 'month';
    default:
      if (spanMs <= 2 * DAY_MS) return 'hour';
      if (spanMs <= 92 * DAY_MS) return 'day';
      if (spanMs <= MAX_DAILY_SPAN) return 'week';
      return 'month';
  }
}

export interface GranularityChoice {
  value: TrafficGranularity;
  label: string;
  enabled: boolean;
  /** Why it cannot be picked, for its tooltip. */
  reason?: string;
}

export function granularityChoices(
  window: TrafficWindow,
  now: number,
  hourlyRetentionDays: number,
): GranularityChoice[] {
  const span = window.to - window.from;
  const reasons: Record<TrafficGranularity, string | undefined> = {
    hour:
      span > MAX_HOURLY_SPAN
        ? 'Pick 14 days or fewer to see hours.'
        : window.from < now - hourlyRetentionDays * DAY_MS
          ? `Hourly figures are kept for ${hourlyRetentionDays} days.`
          : undefined,
    day: span > MAX_DAILY_SPAN ? 'Too many days to draw; pick weeks or months.' : undefined,
    week: span < MIN_WEEKLY_SPAN ? 'Pick four weeks or more to see weeks.' : undefined,
    month: span < MIN_MONTHLY_SPAN ? 'Pick two months or more to see months.' : undefined,
  };
  return GRANULARITY_OPTIONS.map((option) => {
    const reason = reasons[option.value];
    return reason ? { ...option, enabled: false, reason } : { ...option, enabled: true };
  });
}

/** The granularity to use: the one picked when allowed, else the preferred one, else the first allowed. */
export function fitGranularity(
  picked: TrafficGranularity,
  choices: readonly GranularityChoice[],
  preferred: TrafficGranularity,
): TrafficGranularity {
  const allowed = (value: TrafficGranularity) =>
    choices.some((choice) => choice.value === value && choice.enabled);
  if (allowed(picked)) return picked;
  if (allowed(preferred)) return preferred;
  return choices.find((choice) => choice.enabled)?.value ?? 'day';
}

/** A bucket in full, for the readout: "Wed 18 Nov, 14:00", "Week of 16 Nov 2026". */
export function bucketLabel(
  startMs: number,
  granularity: TrafficGranularity,
  timeZone: string,
): string {
  const p = partsIn(startMs, timeZone);
  const month = p.monthName.slice(0, 3);
  const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  switch (granularity) {
    case 'hour':
      return `${p.weekday} ${p.day} ${month}, ${time}`;
    case 'day':
      return `${p.weekday} ${p.day} ${month} ${p.year}`;
    case 'week':
      return `Week of ${p.day} ${month} ${p.year}`;
    default:
      return `${p.monthName} ${p.year}`;
  }
}

/** A bucket on the axis: "14:00", "18 Nov", "Nov 2026". */
export function axisLabel(
  startMs: number,
  granularity: TrafficGranularity,
  timeZone: string,
): string {
  const p = partsIn(startMs, timeZone);
  const month = p.monthName.slice(0, 3);
  if (granularity === 'hour') {
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }
  if (granularity === 'month') return `${month} ${p.year}`;
  return `${p.day} ${month}`;
}
