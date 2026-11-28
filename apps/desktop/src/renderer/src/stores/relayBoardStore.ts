import { create } from 'zustand';

interface RelayBoardState {
  /** The project whose glass board is open, or null when it is closed. */
  projectId: string | null;
  /** A task whose details open with the board. */
  focusTaskId: string | null;
  /** The view the board opens on (E122); the board view when not given. */
  view: 'overview' | 'board' | 'list' | 'roadmap' | 'records';
  open: (
    projectId: string,
    focusTaskId?: string,
    view?: 'overview' | 'board' | 'list' | 'roadmap' | 'records',
  ) => void;
  close: () => void;
}

/**
 * Which Relay board is on screen. The board is one overlay mounted once in the app, so the
 * workspace panel, the status bar, the project page and Blueprint all open it the same way.
 */
export const useRelayBoardStore = create<RelayBoardState>((set) => ({
  projectId: null,
  focusTaskId: null,
  view: 'board',
  open: (projectId, focusTaskId, view) =>
    set({ projectId, focusTaskId: focusTaskId ?? null, view: view ?? 'board' }),
  close: () => set({ projectId: null, focusTaskId: null, view: 'board' }),
}));
