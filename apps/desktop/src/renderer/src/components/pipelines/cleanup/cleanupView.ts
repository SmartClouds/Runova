import type {
  RunnerCleanupDisk,
  RunnerCleanupGroup,
  RunnerCleanupJobKind,
  RunnerCleanupScan,
  RunnerCleanupSchedule,
} from '@shared/apiTypes';
import { formatBytes } from '@/lib/format';

/**
 * The runner cleanup dialog's figures and words as pure functions (E104): the picks, the sizes,
 * the confirm and how a schedule reads.
 */

export type PickState = 'all' | 'some' | 'none';

function usable(group: RunnerCleanupGroup) {
  return group.items.filter((item) => !item.disabledReason);
}

export function defaultPicks(scan: RunnerCleanupScan): Set<string> {
  return new Set(
    scan.groups.flatMap((group) =>
      usable(group)
        .filter((item) => item.picked)
        .map((item) => item.id),
    ),
  );
}

export function groupPickState(group: RunnerCleanupGroup, picks: Set<string>): PickState {
  const items = usable(group);
  const picked = items.filter((item) => picks.has(item.id)).length;
  if (picked === 0) return 'none';
  return picked === items.length ? 'all' : 'some';
}

export function toggleGroup(group: RunnerCleanupGroup, picks: Set<string>): Set<string> {
  const next = new Set(picks);
  const all = groupPickState(group, picks) === 'all';
  for (const item of usable(group)) {
    if (all) next.delete(item.id);
    else next.add(item.id);
  }
  return next;
}

export function toggleItem(id: string, picks: Set<string>): Set<string> {
  const next = new Set(picks);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectionBytes(scan: RunnerCleanupScan, picks: Set<string>): number {
  return scan.groups
    .flatMap((group) => group.items)
    .filter((item) => picks.has(item.id))
    .reduce((total, item) => total + item.bytes, 0);
}

/** Everything the scan found that could go right now. */
export function totalBytes(scan: RunnerCleanupScan): number {
  return scan.groups.flatMap(usable).reduce((total, item) => total + item.bytes, 0);
}

export function diskPercents(
  disk: RunnerCleanupDisk | null,
  freeing: number,
): { now: number; after: number } | null {
  if (!disk || disk.totalBytes <= 0) return null;
  const percent = (bytes: number) =>
    Math.round(Math.max(0, Math.min(100, (bytes / disk.totalBytes) * 100)));
  return { now: percent(disk.usedBytes), after: percent(disk.usedBytes - freeing) };
}

export interface CleanupConfirm {
  title: string;
  description: string;
  items: { name: string; detail: string }[];
  warning?: string;
  confirmLabel: string;
}

export function cleanupConfirm(
  scan: RunnerCleanupScan,
  picks: Set<string>,
  machineName: string,
): CleanupConfirm {
  const picked = scan.groups.flatMap((group) =>
    group.items.filter((item) => picks.has(item.id)).map((item) => ({ group, item })),
  );
  const bytes = picked.reduce((total, entry) => total + entry.item.bytes, 0);
  const runners = picked
    .filter((entry) => entry.item.risk === 'careful')
    .map((entry) => entry.item.label);
  return {
    title: `Free ${formatBytes(bytes)} on ${machineName}?`,
    description:
      'Runova deletes what is listed below. It cannot be undone, but caches and checkouts come back the next time a job needs them.',
    items: picked.map(({ group, item }) => ({
      name:
        group.kind === 'abandoned'
          ? `Runner folder: ${item.label}`
          : `${group.title}: ${item.label}`,
      detail: formatBytes(item.bytes),
    })),
    ...(runners.length > 0
      ? {
          warning: `This removes the runner ${runners.length === 1 ? 'folder' : 'folders'} of ${runners.join(', ')} and ${runners.length === 1 ? 'its service' : 'their services'}. To use one again, add the runner anew.`,
        }
      : {}),
    confirmLabel: `Clean up ${formatBytes(bytes)}`,
  };
}

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function describeSchedule(schedule: RunnerCleanupSchedule): string {
  if (schedule.frequency === 'daily') return `Every day at ${schedule.time}`;
  if (schedule.frequency === 'weekly') {
    return `Every ${WEEKDAYS[schedule.weekday] ?? 'week'} at ${schedule.time}`;
  }
  return `On day ${schedule.dayOfMonth} of every month at ${schedule.time}`;
}

const JOB_NAMES: Record<RunnerCleanupJobKind, string> = {
  cron: 'a cron job',
  launchd: 'a launchd agent',
  task: 'a Task Scheduler task',
};

export function jobLabel(job: RunnerCleanupJobKind, machineName: string): string {
  return `${JOB_NAMES[job]} on ${machineName}`;
}
