import type { StatusBarFeed, StatusBarPlan, StatusBarRun } from '../../../shared/apiTypes';

/** Runs and Relay plans live in the window, so main only knows them while one is open to say. */
export interface StatusFeedWindow {
  on(event: 'destroyed' | 'did-navigate', listener: () => void): unknown;
}

const MAX_RUNS = 32;
const MAX_PLANS = 16;
const MAX_URLS = 8;
const MAX_TEXT = 512;

const RUN_STATES = new Set<string>(['starting', 'running', 'idle', 'paused']);
const PLAN_KINDS = new Set<string>(['split', 'revise', 'catch-up']);
const PLAN_STATUSES = new Set<string>(['running', 'done', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shortText(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : null;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function runOf(value: unknown): StatusBarRun | null {
  if (!isRecord(value)) return null;
  const id = shortText(value.id);
  const title = shortText(value.title);
  const state = shortText(value.state);
  if (id === null || title === null || state === null || !RUN_STATES.has(state)) return null;
  const urls = Array.isArray(value.urls) ? value.urls : [];
  return {
    id,
    title,
    state: state as StatusBarRun['state'],
    cpuPercent: amount(value.cpuPercent),
    memBytes: amount(value.memBytes),
    urls: urls
      .map(shortText)
      .filter((url): url is string => url !== null)
      .slice(0, MAX_URLS),
    device: shortText(value.device),
  };
}

function planOf(value: unknown): StatusBarPlan | null {
  if (!isRecord(value)) return null;
  const key = shortText(value.key);
  const kind = shortText(value.kind);
  const status = shortText(value.status);
  const startedAt = amount(value.startedAt);
  if (key === null || startedAt === null) return null;
  if (kind === null || !PLAN_KINDS.has(kind)) return null;
  if (status === null || !PLAN_STATUSES.has(status)) return null;
  return {
    key,
    kind: kind as StatusBarPlan['kind'],
    projectName: shortText(value.projectName) ?? '',
    status: status as StatusBarPlan['status'],
    startedAt,
    error: shortText(value.error),
  };
}

function listOf<T>(value: unknown, read: (item: unknown) => T | null, limit: number): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(read)
    .filter((item): item is T => item !== null)
    .slice(0, limit);
}

/** What a window sent, trimmed to what the phone needs. Null when it isn't a feed at all. */
export function parseStatusFeed(value: unknown): StatusBarFeed | null {
  if (!isRecord(value) || !Array.isArray(value.runs) || !Array.isArray(value.plans)) return null;
  return {
    runs: listOf(value.runs, runOf, MAX_RUNS),
    plans: listOf(value.plans, planOf, MAX_PLANS),
  };
}

export interface StatusFeed {
  publish(window: StatusFeedWindow, value: unknown): void;
  /** Null while no window is open to say. */
  current(): StatusBarFeed | null;
}

export function createStatusFeed(): StatusFeed {
  let held: { window: StatusFeedWindow; feed: StatusBarFeed } | null = null;
  const watched = new WeakSet<StatusFeedWindow>();
  return {
    publish(window, value) {
      const feed = parseStatusFeed(value);
      if (!feed) return;
      held = { window, feed };
      if (watched.has(window)) return;
      watched.add(window);
      const forget = (): void => {
        if (held?.window === window) held = null;
      };
      // A reload throws the window's state away, so what it said before no longer holds.
      window.on('did-navigate', forget);
      window.on('destroyed', forget);
    },
    current: () => held?.feed ?? null,
  };
}

export const statusFeed = createStatusFeed();
