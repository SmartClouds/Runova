import { EMPTY_FILE_SEND_STATE, type FileSendState } from '@shared/fileSend';
import { create } from 'zustand';

interface FileSendStore {
  state: FileSendState;
  loaded: boolean;
  set: (state: FileSendState) => void;
  /** The device picked to send to, by Runova ID, kept while the person looks at other tabs. */
  picked: string | null;
  pick: (remoteId: string | null) => void;
  note: string;
  setNote: (note: string) => void;
}

/** Sending files (E112), as main last announced it, plus what the person is putting together. */
export const useFileSendStore = create<FileSendStore>((set) => ({
  state: EMPTY_FILE_SEND_STATE,
  loaded: false,
  set: (state) => set({ state, loaded: true }),
  picked: null,
  pick: (picked) => set({ picked }),
  note: '',
  setNote: (note) => set({ note }),
}));

/** Reads the state once and follows main's announcements. Returns the unsubscribe. */
export function initFileSend(): () => void {
  const api = window.runova.fileSend;
  void api
    .getState()
    .then((state) => {
      if (state) useFileSendStore.getState().set(state);
    })
    .catch(() => undefined);
  return api.onState((state) => useFileSendStore.getState().set(state));
}

export function useFileSend(): FileSendState {
  return useFileSendStore((s) => s.state);
}
