import { create } from 'zustand';

/**
 * The steps of each "Update version in files" run, by requestId, as the CLI reports them.
 *
 * Kept out of the dialog because the dialog comes and goes while the run keeps working ("Close,
 * keep it running", switching Workspace projects, following the toast back): opening it again
 * has to show everything the run did so far, not only what arrived since.
 */

/** Plenty for a version bump; past this the oldest lines go, and the panel says how many. */
export const MAX_LOG_LINES = 2000;
/** Runs whose log is kept, newest first. Older ones are long since reviewed. */
const KEPT_RUNS = 8;

export interface RunLog {
  lines: string[];
  /** Lines dropped off the front to stay under MAX_LOG_LINES. */
  dropped: number;
  /** When the run started, for the elapsed time. */
  startedAt: number;
}

interface ApplyVersionLogState {
  logs: Record<string, RunLog>;
  /** Starts an empty log for a run, forgetting the oldest runs past KEPT_RUNS. */
  begin: (requestId: string) => void;
  append: (requestId: string, lines: readonly string[]) => void;
}

export const useApplyVersionLogStore = create<ApplyVersionLogState>((set) => ({
  logs: {},
  begin: (requestId) =>
    set((state) => {
      const kept = Object.entries(state.logs)
        .sort(([, a], [, b]) => b.startedAt - a.startedAt)
        .slice(0, KEPT_RUNS - 1);
      return {
        logs: {
          ...Object.fromEntries(kept),
          [requestId]: { lines: [], dropped: 0, startedAt: Date.now() },
        },
      };
    }),
  append: (requestId, lines) =>
    set((state) => {
      const log = state.logs[requestId];
      if (!log || lines.length === 0) return state;
      const all = [...log.lines, ...lines];
      const over = Math.max(0, all.length - MAX_LOG_LINES);
      return {
        logs: {
          ...state.logs,
          [requestId]: { ...log, lines: over ? all.slice(over) : all, dropped: log.dropped + over },
        },
      };
    }),
}));
