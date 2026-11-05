import type { ProjectCleanupScan } from '@shared/projectCleanupTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { type CleanupSummary, summarize } from '@/lib/projectCleanup/selection';

/** A scan of every project in a row, started from the Projects page. */
export interface BulkScanState {
  running: boolean;
  done: number;
  total: number;
  /** The project being scanned right now. */
  current: string | null;
  failed: number;
}

const IDLE_BULK: BulkScanState = { running: false, done: 0, total: 0, current: null, failed: 0 };

interface ProjectCleanupState {
  /** The latest full result per project, kept while the app runs so reopening a tab is instant. */
  scans: Record<string, ProjectCleanupScan>;
  /** What the Projects page shows for a project, kept between runs of the app. */
  summaries: Record<string, CleanupSummary>;
  bulk: BulkScanState;
  recordScan: (projectId: string, scan: ProjectCleanupScan) => void;
  /** Drops the full result and keeps the summary. */
  clearScan: (projectId: string) => void;
  /** Drops everything remembered about projects that are no longer in the list. */
  forgetProjects: (keep: readonly string[]) => void;
  beginBulk: (total: number) => void;
  stepBulk: (patch: Partial<Omit<BulkScanState, 'running' | 'total'>>) => void;
  endBulk: () => void;
}

export const useProjectCleanupStore = create<ProjectCleanupState>()(
  persist(
    (set) => ({
      scans: {},
      summaries: {},
      bulk: IDLE_BULK,
      recordScan: (projectId, scan) =>
        set((state) => ({
          scans: { ...state.scans, [projectId]: scan },
          summaries: { ...state.summaries, [projectId]: summarize(scan) },
        })),
      clearScan: (projectId) =>
        set((state) => {
          const { [projectId]: _dropped, ...scans } = state.scans;
          return { scans };
        }),
      forgetProjects: (keep) =>
        set((state) => {
          const kept = new Set(keep);
          const strangers = (record: Record<string, unknown>): boolean =>
            Object.keys(record).some((id) => !kept.has(id));
          if (!strangers(state.summaries) && !strangers(state.scans)) return state;
          const only = <T>(record: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(record).filter(([id]) => kept.has(id)));
          return { scans: only(state.scans), summaries: only(state.summaries) };
        }),
      beginBulk: (total) => set({ bulk: { ...IDLE_BULK, running: true, total } }),
      stepBulk: (patch) => set((state) => ({ bulk: { ...state.bulk, ...patch } })),
      endBulk: () => set({ bulk: IDLE_BULK }),
    }),
    {
      name: 'runova-project-cleanup',
      // The scans hold a folder list per project and go stale; only the short summaries last.
      partialize: (state) => ({ summaries: state.summaries }),
    },
  ),
);
