import type { GenerationView } from '@runova/studio';
import { create } from 'zustand';

/** Lines of live output kept per run; the full log is in the run's record. */
export const MAX_OUTPUT_LINES = 300;

/**
 * What the Studio editor shows about AI runs that has to outlive the editor. Leaving the editor
 * for another page unmounts it while the run goes on in the service, so the run's live output
 * keeps arriving here, and the last status the editor saw is kept so a scenario that finished
 * while the user was away still gets its word when they come back.
 *
 * Deliberately not persisted: the full output is in the run's record, and a reload starts over.
 */
interface StudioAiOutputState {
  /** Live output by video id, then by generation id. */
  output: Record<string, Record<string, string[] | undefined> | undefined>;
  /** The status each run had when the editor last looked at it, by generation id. */
  seen: Record<string, GenerationView['status'] | undefined>;
  append: (videoId: string, generationId: string, lines: string[]) => void;
  /**
   * Records the statuses the editor sees now and returns the scenario runs that finished since it
   * last looked, each only once.
   */
  observe: (generations: GenerationView[]) => GenerationView[];
}

export const useStudioAiOutputStore = create<StudioAiOutputState>()((set, get) => ({
  output: {},
  seen: {},
  append: (videoId, generationId, lines) =>
    set((state) => {
      const video = state.output[videoId] ?? {};
      return {
        output: {
          ...state.output,
          [videoId]: {
            ...video,
            [generationId]: [...(video[generationId] ?? []), ...lines].slice(-MAX_OUTPUT_LINES),
          },
        },
      };
    }),
  observe: (generations) => {
    const { seen } = get();
    const finished: GenerationView[] = [];
    let changed = false;
    const next = { ...seen };
    for (const g of generations) {
      const before = seen[g.id];
      if (before === 'running' && g.status === 'done' && g.stage === 'scenario') finished.push(g);
      if (before !== g.status) {
        next[g.id] = g.status;
        changed = true;
      }
    }
    if (changed) set({ seen: next });
    return finished;
  },
}));
