import type { CloneJob, StartCloneInput, StartCloneResult } from '@shared/apiTypes';
import { create } from 'zustand';

/**
 * Background clones, as main last announced them. The clone runs in main, so leaving the page
 * that started it changes nothing; every page reads the same list from here.
 *
 * Deliberately not persisted: main holds the truth and hands it over again on load.
 */

interface CloneJobsState {
  jobs: CloneJob[];
  /** How many cards show each job right now, so a toast doesn't repeat what is on screen. */
  visible: Record<string, number>;
  setJobs: (jobs: CloneJob[]) => void;
  upsert: (job: CloneJob) => void;
  remove: (id: string) => void;
  /** A card showing the job calls this on mount; the returned function on unmount. */
  showCard: (id: string) => () => void;
}

export const useCloneJobsStore = create<CloneJobsState>()((set) => ({
  jobs: [],
  visible: {},
  setJobs: (jobs) => set({ jobs }),
  upsert: (job) =>
    set((state) => {
      const others = state.jobs.filter(
        (one) => one.id !== job.id && one.projectId !== job.projectId,
      );
      const index = state.jobs.findIndex((one) => one.id === job.id);
      if (index === -1) return { jobs: [...others, job] };
      const jobs = [...state.jobs];
      jobs[index] = job;
      return { jobs };
    }),
  remove: (id) => set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) })),
  showCard: (id) => {
    set((state) => ({ visible: { ...state.visible, [id]: (state.visible[id] ?? 0) + 1 } }));
    let shown = true;
    return () => {
      if (!shown) return;
      shown = false;
      set((state) => {
        const visible = { ...state.visible };
        const left = (visible[id] ?? 1) - 1;
        if (left > 0) visible[id] = left;
        else delete visible[id];
        return { visible };
      });
    };
  },
}));

/** Loads the jobs main has and follows its announcements. Returns the unsubscribe. */
export function initCloneJobs(): () => void {
  const api = window.runova.git;
  let heard = false;
  const stop = api.onCloneJobs((jobs) => {
    heard = true;
    useCloneJobsStore.getState().setJobs(jobs ?? []);
  });
  void Promise.resolve(api.cloneJobs())
    .then((jobs) => {
      // An announcement that beat the first load is newer than what the load read.
      if (!heard) useCloneJobsStore.getState().setJobs(jobs ?? []);
    })
    .catch(() => undefined);
  return stop;
}

/**
 * Starts a clone in main and shows its job right away, before main's first announcement lands.
 * Never throws: a failed call comes back as `ok: false` with the reason.
 */
export async function startClone(input: StartCloneInput): Promise<StartCloneResult> {
  try {
    const result = await window.runova.git.startClone(input);
    if (result.job) useCloneJobsStore.getState().upsert(result.job);
    return result;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Clone failed.' };
  }
}

export async function cancelClone(id: string): Promise<void> {
  await window.runova.git.cancelClone(id).catch(() => undefined);
}

/** Forgets a finished job here at once, and in main. */
export async function dismissClone(id: string): Promise<void> {
  useCloneJobsStore.getState().remove(id);
  await window.runova.git.dismissClone(id).catch(() => undefined);
}

export function useCloneJobForProject(projectId: string): CloneJob | undefined {
  return useCloneJobsStore((state) => state.jobs.find((job) => job.projectId === projectId));
}

export function useCloneJobs(): CloneJob[] {
  return useCloneJobsStore((state) => state.jobs);
}
