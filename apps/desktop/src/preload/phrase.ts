import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type { PendingPhrase, PhrasePurpose } from '../shared/phraseTypes';

/** Recovery phrases (E107): made and kept in the main process, used from the page by id. */
export function createPhrase() {
  return {
    create: (purpose: PhrasePurpose, label: string): Promise<PendingPhrase> =>
      ipcRenderer.invoke(IPC.phrase.create, { purpose, label }),
    qr: (id: string): Promise<{ dataUrl: string }> => ipcRenderer.invoke(IPC.phrase.qr, { id }),
    copy: (id: string): Promise<{ clearsAt: number | null }> =>
      ipcRenderer.invoke(IPC.phrase.copy, { id }),
    save: (id: string): Promise<{ path: string } | null> =>
      ipcRenderer.invoke(IPC.phrase.save, { id }),
    open: (): Promise<{ phrase: string } | null> => ipcRenderer.invoke(IPC.phrase.open),
    discard: (id: string): Promise<void> => ipcRenderer.invoke(IPC.phrase.discard, { id }),
    protect: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.phrase.protect, { on }),
  };
}
