import { flicksToSeconds, secondsToFlicks } from '@runova/studio';

/** A service error in plain words, without Electron's "Error invoking remote method" prefix. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** "5 minutes ago", "yesterday", "just now". */
export function formatWhen(at: number, now = Date.now()): string {
  const diff = at - now;
  for (const [unit, size] of STEPS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  }
  return 'just now';
}

export interface DayGroup<T> {
  /** The day's local date, as YYYY-MM-DD, to key the group by. */
  key: string;
  /** "Today", "Yesterday", or a short date ("Mar 3", with the year when it is not this one). */
  label: string;
  items: T[];
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * Splits a list that is already newest first into one group per local day, keeping its order, so
 * a long history reads by day.
 */
export function groupByDay<T>(
  items: T[],
  at: (item: T) => number,
  now = Date.now(),
): DayGroup<T>[] {
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const date = new Date(at(item));
    const key = dayKey(date);
    let group = groups.at(-1);
    if (group?.key !== key) {
      const label =
        key === dayKey(today)
          ? 'Today'
          : key === dayKey(yesterday)
            ? 'Yesterday'
            : date.toLocaleDateString('en', {
                month: 'short',
                day: 'numeric',
                ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
              });
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** A scene length for a field: whole seconds stay whole, the rest get one decimal. */
export function flicksToFieldSeconds(flicks: number): string {
  const seconds = flicksToSeconds(flicks);
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

/** Reads a typed length in seconds, or null when it is not a usable length (0.5 s to 10 min). */
export function fieldSecondsToFlicks(text: string): number | null {
  const seconds = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 600) return null;
  return secondsToFlicks(Math.round(seconds * 10) / 10);
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'];

/** "1.2 GB", "640 KB": one decimal below 10, none above. */
export function formatBytes(bytes: number): string {
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${BYTE_UNITS[unit]}`;
}

/** "45 s", "3 min 20 s", "1 h 5 min": a length or a wait, as people say it. */
export function formatSeconds(total: number): string {
  const seconds = Math.max(0, Math.round(total));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

/** Persian text in a field gets the app's Persian font; the field's direction follows its text. */
export function scriptClass(text: string): string | undefined {
  return /[؀-ۿ]/.test(text) ? 'font-vazirmatn' : undefined;
}

/**
 * The middle row of a dialog whose content can run long. It reaches the dialog's edges, so the
 * scrollbar sits at the edge and a field's 3 px focus glow is never clipped, and the dialog's
 * footer stays in view below it.
 */
export const DIALOG_BODY = '-mx-6 -my-1 min-h-0 overflow-y-auto px-6 py-1';
