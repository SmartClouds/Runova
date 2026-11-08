import { type AnywhereState, EMPTY_ANYWHERE_STATE } from '@shared/anywhere';
import { create } from 'zustand';

interface AnywhereStore {
  state: AnywhereState;
  loaded: boolean;
  set: (state: AnywhereState) => void;
}

/** Runova Anywhere's state as main last announced it (E61), for every window that shows it. */
export const useAnywhereStore = create<AnywhereStore>((set) => ({
  state: EMPTY_ANYWHERE_STATE,
  loaded: false,
  set: (state) => set({ state, loaded: true }),
}));

/** Reads the state once and follows main's announcements. Returns the unsubscribe. */
export function initAnywhere(): () => void {
  const api = window.runova.anywhere;
  void api
    .getState()
    .then((state) => {
      if (state) useAnywhereStore.getState().set(state);
    })
    .catch(() => undefined);
  return api.onState((state) => useAnywhereStore.getState().set(state));
}

export function useAnywhere(): AnywhereState {
  return useAnywhereStore((s) => s.state);
}
