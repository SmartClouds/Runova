import type { RelayItem, RelayPriority, RelaySize } from '@runova/core';
import type { RelayTaskCard } from '@shared/relayTypes';

/** The task manager's views of a board (E122), as pure functions of its cards and records. */

export const PRIORITY_WORDS: Record<RelayPriority, string> = {
  p0: 'P0 Urgent',
  p1: 'P1 High',
  p2: 'P2 Normal',
  p3: 'P3 Low',
};

export const SIZE_WORDS: Record<RelaySize, string> = {
  xs: 'XS',
  s: 'S',
  m: 'M',
  l: 'L',
  xl: 'XL',
};

export interface Progress {
  done: number;
  total: number;
  /** Whole percent, 0 when there is nothing to do. */
  percent: number;
}

export function progressOf(tasks: readonly Pick<RelayTaskCard, 'status'>[]): Progress {
  const done = tasks.filter((task) => task.status === 'done').length;
  const total = tasks.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export interface MilestoneRow {
  /** Null for the tasks that belong to no milestone. */
  milestone: RelayItem | null;
  tasks: RelayTaskCard[];
  progress: Progress;
}

/**
 * Milestones in id order, each with its tasks, and a last row for tasks with no milestone (or one
 * that does not exist) when there are any.
 */
export function milestoneRows(
  tasks: readonly RelayTaskCard[],
  milestones: readonly RelayItem[],
): MilestoneRow[] {
  const known = new Set(milestones.map((milestone) => milestone.id));
  const rows: MilestoneRow[] = [...milestones]
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    .map((milestone) => {
      const own = tasks.filter((task) => task.milestone === milestone.id);
      return { milestone, tasks: own, progress: progressOf(own) };
    });
  const loose = tasks.filter((task) => !task.milestone || !known.has(task.milestone));
  if (loose.length > 0) rows.push({ milestone: null, tasks: loose, progress: progressOf(loose) });
  return rows;
}

export type TaskSortKey = 'id' | 'title' | 'status' | 'priority' | 'size' | 'milestone' | 'due';

const STATUS_RANK: Record<RelayTaskCard['status'], number> = {
  blocked: 0,
  'in-progress': 1,
  testing: 2,
  todo: 3,
  done: 4,
};
const SIZE_RANK: Record<RelaySize, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };

function compareBy(key: TaskSortKey, a: RelayTaskCard, b: RelayTaskCard): number {
  // Empty values sort last whichever way the column runs, so they never crowd the top.
  const missing = (left: unknown, right: unknown): number | null => {
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return null;
  };
  switch (key) {
    case 'id':
      return a.id.localeCompare(b.id, 'en', { numeric: true });
    case 'title':
      return a.title.localeCompare(b.title);
    case 'status':
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    case 'priority':
      return (
        missing(a.priority, b.priority) ??
        (a.priority as string).localeCompare(b.priority as string)
      );
    case 'size':
      return (
        missing(a.size, b.size) ?? SIZE_RANK[a.size as RelaySize] - SIZE_RANK[b.size as RelaySize]
      );
    case 'milestone':
      return (
        missing(a.milestone, b.milestone) ??
        (a.milestone as string).localeCompare(b.milestone as string, 'en', { numeric: true })
      );
    case 'due':
      return missing(a.due, b.due) ?? (a.due as string).localeCompare(b.due as string);
  }
}

export function sortTasks(
  tasks: readonly RelayTaskCard[],
  key: TaskSortKey,
  descending = false,
): RelayTaskCard[] {
  return [...tasks].sort((a, b) => {
    const order = compareBy(key, a, b);
    const blankA = key !== 'id' && key !== 'title' && key !== 'status' && a[key] == null;
    const blankB = key !== 'id' && key !== 'title' && key !== 'status' && b[key] == null;
    if (blankA !== blankB) return blankA ? 1 : -1;
    const result = descending ? -order : order;
    return result || a.id.localeCompare(b.id, 'en', { numeric: true });
  });
}

export interface TaskFilter {
  text: string;
  status: RelayTaskCard['status'] | null;
  priority: RelayPriority | null;
  milestone: string | null;
  label: string | null;
}

export const NO_FILTER: TaskFilter = {
  text: '',
  status: null,
  priority: null,
  milestone: null,
  label: null,
};

export function filterTasks(tasks: readonly RelayTaskCard[], filter: TaskFilter): RelayTaskCard[] {
  const text = filter.text.trim().toLowerCase();
  return tasks.filter(
    (task) =>
      (!text || task.id.toLowerCase().includes(text) || task.title.toLowerCase().includes(text)) &&
      (!filter.status || task.status === filter.status) &&
      (!filter.priority || task.priority === filter.priority) &&
      (!filter.milestone || task.milestone === filter.milestone) &&
      (!filter.label || task.labels.includes(filter.label)),
  );
}

/** A task's acceptance criteria, as the card counts them: under the heading, or the whole body. */
export function acceptanceItems(body: string): { text: string; checked: boolean }[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,4}\s+.*acceptance/i.test(line));
  let scope = lines;
  if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && /^#{1,4}\s+/.test(line));
    scope = lines.slice(start + 1, end === -1 ? undefined : end);
  }
  const items: { text: string; checked: boolean }[] = [];
  for (const line of scope) {
    const match = /^\s*[-*+]\s+\[( |x|X)\]\s*(.*)$/.exec(line);
    if (match) items.push({ text: match[2].trim(), checked: match[1] !== ' ' });
  }
  return items;
}

/** Whether a date written as `YYYY-MM-DD` is before today. */
export function isOverdue(date: string | null, today: string): boolean {
  return Boolean(date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today);
}

export function todayString(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
