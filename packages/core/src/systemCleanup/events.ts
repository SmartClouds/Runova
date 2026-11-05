import type {
  CacheProviderId,
  CleanFailure,
  ProviderScan,
  ProviderStatus,
  SystemCleanEvent,
  SystemScanEvent,
} from './types.js';

/**
 * What the window knows while a scan or a clean-up is running, built up one event at a time.
 * Both are pure, so the same events always give the same picture, and both ignore events from a
 * run that is not the one in progress (a late message from a run that was cancelled).
 *
 * Each event costs the same however long the run has been going: counts and a short tail of
 * output are kept, not a record of every step.
 */

// --- A scan --------------------------------------------------------------------------------

export interface ScanProviderProgress {
  status: ProviderStatus;
  label: string;
  bytes: number;
  files: number;
  /** The finished answer for this cache, once it has one. */
  result: ProviderScan | null;
}

export interface ScanProgress {
  requestId: string | null;
  scanId: string | null;
  running: boolean;
  cancelled: boolean;
  /** The caches in the order they will be looked at. */
  order: CacheProviderId[];
  providers: Partial<Record<CacheProviderId, ScanProviderProgress>>;
}

export const IDLE_SCAN: ScanProgress = {
  requestId: null,
  scanId: null,
  running: false,
  cancelled: false,
  order: [],
  providers: {},
};

export function applyScanEvent(state: ScanProgress, event: SystemScanEvent): ScanProgress {
  if (event.type === 'started') {
    const providers: ScanProgress['providers'] = {};
    for (const provider of event.providers) {
      providers[provider.id] = {
        status: 'queued',
        label: provider.label,
        bytes: 0,
        files: 0,
        result: null,
      };
    }
    return {
      requestId: event.requestId,
      scanId: event.scanId,
      running: true,
      cancelled: false,
      order: event.providers.map((provider) => provider.id),
      providers,
    };
  }
  if (event.requestId !== state.requestId) return state;

  if (event.type === 'finished') {
    return { ...state, running: false, cancelled: event.cancelled };
  }

  const id = event.type === 'provider-done' ? event.provider.id : event.providerId;
  const current = state.providers[id];
  if (!current) return state;

  if (event.type === 'provider-started') {
    return {
      ...state,
      providers: {
        ...state.providers,
        [id]: { ...current, status: 'scanning', bytes: 0, files: 0 },
      },
    };
  }
  if (event.type === 'progress') {
    return {
      ...state,
      providers: {
        ...state.providers,
        [id]: {
          ...current,
          bytes: Math.max(current.bytes, event.bytes),
          files: Math.max(current.files, event.files),
        },
      },
    };
  }
  return {
    ...state,
    providers: {
      ...state.providers,
      [id]: {
        ...current,
        status: event.provider.status,
        bytes: event.provider.bytes,
        files: event.provider.files,
        result: event.provider,
      },
    },
  };
}

// --- A clean-up ----------------------------------------------------------------------------

const MAX_LINES = 200;

export interface CleanProgress {
  requestId: string | null;
  providerId: CacheProviderId | null;
  running: boolean;
  cancelled: boolean;
  /** How many things the run will go through, and how many bytes they hold. */
  total: number;
  bytes: number;
  /** Things dealt with so far, removed or failed. */
  processed: number;
  freedBytes: number;
  /** What it is working on now. */
  current: string | null;
  failures: CleanFailure[];
  /** The last lines a tool's command printed. */
  lines: string[];
}

export const IDLE_CLEAN: CleanProgress = {
  requestId: null,
  providerId: null,
  running: false,
  cancelled: false,
  total: 0,
  bytes: 0,
  processed: 0,
  freedBytes: 0,
  current: null,
  failures: [],
  lines: [],
};

export function applyCleanEvent(state: CleanProgress, event: SystemCleanEvent): CleanProgress {
  if (event.type === 'started') {
    return {
      ...IDLE_CLEAN,
      requestId: event.requestId,
      providerId: event.providerId,
      running: true,
      total: event.total,
      bytes: event.bytes,
    };
  }
  if (event.requestId !== state.requestId) return state;

  switch (event.type) {
    case 'item-done':
      return {
        ...state,
        processed: state.processed + 1,
        freedBytes: state.freedBytes + event.bytes,
        current: event.label,
      };
    case 'item-failed':
      return {
        ...state,
        processed: state.processed + 1,
        current: event.label,
        failures: [
          ...state.failures,
          { itemId: event.itemId, label: event.label, reason: event.reason },
        ],
      };
    case 'line':
      return { ...state, lines: [...state.lines, event.text].slice(-MAX_LINES) };
    case 'finished':
      return { ...state, running: false, cancelled: event.cancelled };
  }
}

/** How far through its items a clean-up is, from 0 to 1. */
export function cleanFraction(state: CleanProgress): number {
  if (state.total <= 0) return 0;
  return Math.min(1, state.processed / state.total);
}
