import { ipcRenderer } from 'electron';
import type { FileSendBridge, FileSendState } from '../shared/fileSend';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * Sending files to your other devices and teammates (E112). Main keeps where every staged and
 * received file is; the screens deal in ids.
 */
export function createFileSend(subscribe: Subscribe): FileSendBridge {
  return {
    getState: () => ipcRenderer.invoke(IPC.fileSend.getState),
    stagePaths: (paths) => ipcRenderer.invoke(IPC.fileSend.stagePaths, paths),
    pickFiles: () => ipcRenderer.invoke(IPC.fileSend.pickFiles),
    pickFolder: () => ipcRenderer.invoke(IPC.fileSend.pickFolder),
    unstage: (ids) => ipcRenderer.invoke(IPC.fileSend.unstage, ids),
    send: (request) => ipcRenderer.invoke(IPC.fileSend.send, request),
    cancel: (batchId) => ipcRenderer.invoke(IPC.fileSend.cancel, batchId),
    cancelFile: (batchId, transferId) =>
      ipcRenderer.invoke(IPC.fileSend.cancelFile, batchId, transferId),
    retry: (batchId) => ipcRenderer.invoke(IPC.fileSend.retry, batchId),
    dismiss: (batchId) => ipcRenderer.invoke(IPC.fileSend.dismiss, batchId),
    clearFinished: () => ipcRenderer.invoke(IPC.fileSend.clearFinished),
    respond: (batchId, answer) => ipcRenderer.invoke(IPC.fileSend.respond, batchId, answer),
    chooseFolder: (batchId) => ipcRenderer.invoke(IPC.fileSend.chooseFolder, batchId),
    chooseSaveFolder: () => ipcRenderer.invoke(IPC.fileSend.chooseSaveFolder),
    updateSettings: (patch) => ipcRenderer.invoke(IPC.fileSend.updateSettings, patch),
    showInFolder: (batchId, transferId) =>
      ipcRenderer.invoke(IPC.fileSend.showInFolder, batchId, transferId),
    openFile: (batchId, transferId) =>
      ipcRenderer.invoke(IPC.fileSend.openFile, batchId, transferId),
    openApp: () => ipcRenderer.invoke(IPC.fileSend.openApp),
    onState: (callback: (state: FileSendState) => void) =>
      subscribe(IPC.fileSend.onState, callback),
  };
}
