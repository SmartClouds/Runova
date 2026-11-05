import {
  applyCleanEvent,
  applyScanEvent,
  type CacheProviderId,
  type CleanProgress,
  type CleanResult,
  type CleanSelection,
  IDLE_CLEAN,
  IDLE_SCAN,
  type ProviderScan,
  type ScanProgress,
  type SystemCleanupScan,
  type SystemCleanupStatus,
} from '@runova/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { isCancelled, runClean, runScan } from '@/lib/systemCleanup/runner';
import { type ProviderSummary, summaryOf } from '@/lib/systemCleanup/view';

/**
 * Disk Cleanup's state, kept outside the page on purpose. Reading a large cache takes a minute or
 * more, so a scan has to keep going, and keep its progress, while the person looks at another page.
 * Only short summaries are kept between runs of the app; what lets something be cleaned is the
 * live scan held by the main process, which is why a remembered cache is read again first.
 */

export interface ItemStatus {
  status: 'done' | 'failed';
  bytes?: number;
  reason?: string;
}

/** Between one and three versions of each package can be kept. */
const MOST_TO_KEEP = 3;

/** What `setState` and the tests can set, apart from the actions. */
interface SystemCleanupState {
  /** Whether Disk Cleanup is on. It is off in a test run that has no sandbox. */
  availability: SystemCleanupStatus | null;
  /** The scan held by the main process in this run of the app. */
  scan: SystemCleanupScan | null;
  /** What a scan under way has found so far. */
  progress: ScanProgress;
  /** How a clean-up under way is going. */
  cleaning: CleanProgress;
  /** What happened to each thing in the last clean-ups, by `cache/item`. */
  itemStatuses: Record<string, ItemStatus>;
  lastResult: CleanResult | null;
  error: string | null;
  /** What is remembered about each cache between runs of the app. */
  summaries: Partial<Record<CacheProviderId, ProviderSummary>>;
  /** How many versions of each package a clean-up keeps. */
  keep: number;

  checkAvailability: () => Promise<void>;
  /** Reads the caches named, or all of them. A run already going is left alone. */
  startScan: (providerIds?: CacheProviderId[]) => Promise<void>;
  startClean: (selection: CleanSelection) => Promise<CleanResult | null>;
  /** Stops the scan or clean-up that is running. */
  cancel: () => void;
  setKeep: (keep: number) => void;
  dismissResult: () => void;
}

/**
 * The run in progress, kept to be cancelled. Whether one is running is read from the state, so
 * the state is the only thing that can say so.
 */
let running: AbortController | null = null;

function replaceProvider(scan: SystemCleanupScan, provider: ProviderScan): SystemCleanupScan {
  return {
    ...scan,
    providers: scan.providers.map((existing) =>
      existing.id === provider.id ? provider : existing,
    ),
  };
}

export const useSystemCleanupStore = create<SystemCleanupState>()(
  persist(
    (set, get) => ({
      availability: null,
      scan: null,
      progress: IDLE_SCAN,
      cleaning: IDLE_CLEAN,
      itemStatuses: {},
      lastResult: null,
      error: null,
      summaries: {},
      keep: 1,

      async checkAvailability() {
        try {
          const status = await window.runova.systemCleanup.status();
          set({ availability: status ?? { enabled: true } });
        } catch {
          set({ availability: { enabled: true } });
        }
      },

      async startScan(providerIds) {
        if (get().progress.running || get().cleaning.running) return;
        const controller = new AbortController();
        running = controller;
        // Shows as scanning at once, without waiting for the first event from the main process.
        set({ error: null, progress: { ...IDLE_SCAN, running: true } });
        try {
          const result = await runScan({
            providerIds,
            signal: controller.signal,
            onEvent: (event) =>
              set((state) => ({ progress: applyScanEvent(state.progress, event) })),
          });
          set((state) => {
            const summaries = { ...state.summaries };
            for (const provider of result.providers) {
              if (provider.status === 'missing') {
                delete summaries[provider.id];
                continue;
              }
              const summary = summaryOf(provider, result.finishedAt, state.keep);
              if (summary) summaries[provider.id] = summary;
            }
            return { scan: result, summaries };
          });
        } catch (caught) {
          if (!isCancelled(caught)) {
            set({ error: ipcErrorMessage(caught, 'The scan could not finish.') });
          }
        } finally {
          if (running === controller) running = null;
          set((state) => ({ progress: { ...state.progress, running: false } }));
        }
      },

      async startClean(selection) {
        const { scan } = get();
        if (get().progress.running || get().cleaning.running) return null;
        if (!scan) {
          set({ error: 'Scan first, then clean up.' });
          return null;
        }

        const controller = new AbortController();
        running = controller;
        set((state) => ({
          error: null,
          lastResult: null,
          // Shows as cleaning at once, without waiting for the first event.
          cleaning: { ...IDLE_CLEAN, running: true },
          itemStatuses: Object.fromEntries(
            Object.entries(state.itemStatuses).filter(
              ([key]) => !key.startsWith(`${selection.providerId}/`),
            ),
          ),
        }));
        try {
          const result = await runClean(scan.scanId, selection, {
            signal: controller.signal,
            onEvent: (event) =>
              set((state) => {
                const cleaning = applyCleanEvent(state.cleaning, event);
                if (event.type === 'item-done') {
                  return {
                    cleaning,
                    itemStatuses: {
                      ...state.itemStatuses,
                      [`${event.providerId}/${event.itemId}`]: {
                        status: 'done',
                        bytes: event.bytes,
                      },
                    },
                  };
                }
                if (event.type === 'item-failed') {
                  return {
                    cleaning,
                    itemStatuses: {
                      ...state.itemStatuses,
                      [`${event.providerId}/${event.itemId}`]: {
                        status: 'failed',
                        reason: event.reason,
                      },
                    },
                  };
                }
                return { cleaning };
              }),
          });
          set((state) => {
            const summary = summaryOf(result.provider, Date.now(), state.keep);
            // The events can be thinned out on the way, so a failure the result reports is kept too.
            const itemStatuses = { ...state.itemStatuses };
            for (const failure of result.failed) {
              if (failure.itemId === null) continue;
              itemStatuses[`${result.providerId}/${failure.itemId}`] = {
                status: 'failed',
                reason: failure.reason,
              };
            }
            const scan = state.scan
              ? {
                  ...replaceProvider(state.scan, result.provider),
                  volumes: result.volumes ?? state.scan.volumes,
                }
              : state.scan;
            return {
              lastResult: result,
              itemStatuses,
              scan,
              summaries: summary
                ? { ...state.summaries, [result.providerId]: summary }
                : state.summaries,
            };
          });
          return result;
        } catch (caught) {
          if (!isCancelled(caught)) {
            set({ error: ipcErrorMessage(caught, 'Could not clean up.') });
          }
          return null;
        } finally {
          if (running === controller) running = null;
          set((state) => ({ cleaning: { ...state.cleaning, running: false } }));
        }
      },

      cancel() {
        running?.abort();
      },

      setKeep(keep) {
        const whole = Number.isFinite(keep) ? Math.floor(keep) : 1;
        set({ keep: Math.min(MOST_TO_KEEP, Math.max(1, whole)) });
      },

      dismissResult() {
        set({ lastResult: null, error: null });
      },
    }),
    {
      name: 'runova-system-cleanup',
      // A live scan goes stale the moment the app closes, so only the summaries and the setting last.
      partialize: (state) => ({ summaries: state.summaries, keep: state.keep }),
    },
  ),
);
