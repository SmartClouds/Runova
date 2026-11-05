/** The admin Reports page's numbers, as `GET /api/v1/reports/current` hands them to an Admin. */

export interface DailyCount {
  /** A UTC day as `yyyy-MM-dd`. */
  date: string;
  count: number;
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface NewUser {
  id: number;
  displayName: string;
  email: string;
  staff: boolean;
  createdAt: string;
}

export interface Report {
  generatedAt: string;
  days: number;
  users: {
    total: number;
    accounts: number;
    admins: number;
    editors: number;
    disabled: number;
    unconfirmed: number;
    twoFactor: number;
    joined: number;
    active: number;
  };
  signUps: DailyCount[];
  newestUsers: NewUser[];
  sessions: { web: number; desktop: number; platforms: NamedCount[]; appVersions: NamedCount[] };
  teams: { total: number; members: number; pendingInvitations: number };
  sync: { scopes: number; items: number; bytes: number };
  content: {
    newsPublished: number;
    newsScheduled: number;
    newsDrafts: number;
    postsPublished: number;
    postsScheduled: number;
    postsDrafts: number;
    media: number;
  };
  apiClients: { active: number; inactive: number };
  latestRelease: string | null;
}

/** The periods the page offers, in days. 30 is the API's default. */
export const PERIODS = [7, 30, 90, 365] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = 30;

export const PERIOD_LABELS: Record<Period, string> = {
  7: 'Last 7 days',
  30: 'Last 30 days',
  90: 'Last 90 days',
  365: 'Last 12 months',
};

/** The period in the address (`?days=90`), or the default when it is missing or not offered. */
export function readPeriod(search: string): Period {
  const days = Number(new URLSearchParams(search).get('days'));
  return (PERIODS as readonly number[]).includes(days) ? (days as Period) : DEFAULT_PERIOD;
}

const counts = new Intl.NumberFormat('en');

export const formatCount = (value: number) => counts.format(value);

/** A share as a whole percent, and 0% when there is nothing to share. */
export const percentOf = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/** Bytes in 1024 steps, one decimal past the first unit: `0 bytes`, `512 bytes`, `1.5 MB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${value} ${value === 1 ? 'byte' : 'bytes'}`;
  return `${value.toFixed(1).replace(/\.0$/, '')} ${UNITS[unit]}`;
}

const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** `2026-11-05` as `Nov 5`, read as the UTC day it is. */
export const formatDay = (date: string) => day.format(new Date(`${date}T00:00:00Z`));

/**
 * The sign-ups grouped into at most `bars` bars, so a year still fits: each bar sums a run of
 * days and is named by its first and last day. The newest days are never split.
 */
export function bucketDays(days: DailyCount[], bars = 31): { label: string; count: number }[] {
  const size = Math.max(1, Math.ceil(days.length / bars));
  const buckets: { label: string; count: number }[] = [];
  // From the newest day back, so a short first bucket holds the oldest days.
  for (let end = days.length; end > 0; end -= size) {
    const run = days.slice(Math.max(0, end - size), end);
    const first = formatDay(run[0].date);
    const last = formatDay(run[run.length - 1].date);
    buckets.unshift({
      label: first === last ? first : `${first} to ${last}`,
      count: run.reduce((sum, each) => sum + each.count, 0),
    });
  }
  return buckets;
}

/** The desktop app version, or what to call a computer that sent none. */
export const versionName = (name: string) => name || 'Unknown version';

const PLATFORM_NAMES: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

export const platformName = (name: string) =>
  PLATFORM_NAMES[name.toLowerCase()] ?? (name || 'Unknown');
