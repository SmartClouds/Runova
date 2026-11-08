import { ipcMain } from 'electron';
import type { RemoteConnectIntent, RemoteState } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { canUseRemote, REMOTE_SIGN_IN_ERROR } from '../../shared/remoteAccess';
import {
  decodePairingCode,
  type RemoteInputEvent,
  type RemoteRtcMessage,
} from '../../shared/remoteProtocol';
import { getAccountRuntime } from '../account/live';
import { remoteManager } from '../remote/manager';
import { listNetworkInterfaces } from '../remote/networkInterfaces';

/** Starting remote control needs a Runova sign-in; the screens ask first, and this holds anyway. */
async function signedIn(): Promise<boolean> {
  return canUseRemote(await getAccountRuntime().status());
}

const SIGN_IN_FIRST = { ok: false, error: REMOTE_SIGN_IN_ERROR };

export function registerRemoteHandlers(): void {
  ipcMain.handle(IPC.remote.getState, (): RemoteState => remoteManager.getState());

  ipcMain.handle(IPC.remote.listInterfaces, () => listNetworkInterfaces());

  ipcMain.handle(IPC.remote.startHost, async (_e, input: { ip: string; port: number }) => {
    if (!(await signedIn())) throw new Error(REMOTE_SIGN_IN_ERROR);
    return remoteManager.startHost(input.ip, input.port);
  });

  ipcMain.handle(IPC.remote.stopHost, () => {
    remoteManager.stopHost();
  });

  ipcMain.handle(IPC.remote.generatePairingCode, () => remoteManager.generatePairingCode());

  // The control and files variants differ only in the intent they dial with, so
  // the code validation and its error copy live in one place.
  const pairingConnect =
    (intent?: RemoteConnectIntent) =>
    async (_e: unknown, code: string): Promise<{ ok: boolean; error?: string }> => {
      if (!(await signedIn())) return SIGN_IN_FIRST;
      const payload = decodePairingCode(code);
      if (!payload) return { ok: false, error: 'That pairing code is not valid.' };
      remoteManager.connect(payload, intent);
      return { ok: true };
    };

  ipcMain.handle(IPC.remote.connect, pairingConnect());

  ipcMain.handle(IPC.remote.connectFiles, pairingConnect('files'));

  ipcMain.handle(IPC.remote.disconnect, () => {
    remoteManager.closeSessionAndDisconnect();
  });

  ipcMain.handle(IPC.remote.listSavedServers, () => remoteManager.listSavedServers());

  const savedConnect = (intent?: RemoteConnectIntent) => async (_e: unknown, id: string) => {
    if (!(await signedIn())) return SIGN_IN_FIRST;
    return remoteManager.connectSaved(id, intent);
  };

  ipcMain.handle(IPC.remote.connectSaved, savedConnect());

  ipcMain.handle(IPC.remote.connectSavedFiles, savedConnect('files'));

  ipcMain.handle(IPC.remote.renameSavedServer, (_e, id: string, nickname: string) =>
    remoteManager.renameSavedServer(id, nickname),
  );

  ipcMain.handle(IPC.remote.removeSavedServer, (_e, id: string) =>
    remoteManager.removeSavedServer(id),
  );

  ipcMain.handle(IPC.remote.openSessionWindow, () => {
    remoteManager.openSessionWindow();
  });

  ipcMain.handle(IPC.remote.sendClipboard, () => {
    remoteManager.sendClipboard();
  });

  ipcMain.handle(IPC.remote.sendFile, () => remoteManager.sendFile());

  ipcMain.handle(IPC.remote.getFileProgress, () => remoteManager.getFileProgress());

  ipcMain.handle(IPC.remote.fmRoots, () => remoteManager.fmRoots());

  ipcMain.handle(IPC.remote.fmList, (_e, path: string | null) => remoteManager.fmList(path));

  ipcMain.handle(IPC.remote.fmMkdir, (_e, parentPath: string, name: string) =>
    remoteManager.fmMkdir(parentPath, name),
  );

  ipcMain.handle(IPC.remote.fmDelete, (_e, path: string) => remoteManager.fmDelete(path));

  ipcMain.handle(IPC.remote.fmRename, (_e, path: string, newName: string) =>
    remoteManager.fmRename(path, newName),
  );

  ipcMain.handle(IPC.remote.fmUploadTo, (_e, destDir: string) =>
    remoteManager.uploadFileTo(destDir),
  );

  ipcMain.handle(IPC.remote.fmDownload, (_e, path: string) => remoteManager.downloadFile(path));

  // High-frequency, fire-and-forget channels use send/on rather than invoke so
  // they don't pay for a round-trip acknowledgement per event/tile.
  ipcMain.on(IPC.remote.sendInput, (_e, event: RemoteInputEvent) => {
    remoteManager.sendInput(event);
  });

  ipcMain.on(IPC.remote.setScreenInfo, (_e, size: { width: number; height: number }) => {
    remoteManager.setScreenInfo(size.width, size.height);
  });

  ipcMain.on(IPC.remote.setDisplaySize, (_e, size: { width: number; height: number }) => {
    remoteManager.setDisplaySize(size.width, size.height);
  });

  ipcMain.on(IPC.remote.hostTile, (_e, tile: ArrayBuffer | Uint8Array) => {
    const bytes = tile instanceof Uint8Array ? tile : new Uint8Array(tile);
    remoteManager.hostTile(bytes);
  });

  ipcMain.on(IPC.remote.rtcSignal, (_e, payload: { peerId: string; message: RemoteRtcMessage }) => {
    remoteManager.rtcSignalToPeer(payload.peerId, payload.message);
  });

  ipcMain.on(IPC.remote.rtcPeerState, (_e, payload: { peerId: string; connected: boolean }) => {
    remoteManager.setRtcPeerConnected(payload.peerId, payload.connected);
  });

  ipcMain.on(IPC.remote.clientRtcSignal, (_e, message: RemoteRtcMessage) => {
    remoteManager.sendClientRtcSignal(message);
  });

  ipcMain.on(IPC.remote.rtcInput, (_e, payload: { peerId: string; event: RemoteInputEvent }) => {
    remoteManager.applyRtcInput(payload.peerId, payload.event);
  });

  ipcMain.on(IPC.remote.setCursorTracking, (_e, enabled: boolean) => {
    remoteManager.setCursorTracking(enabled);
  });

  // Benchmarking: the renderer can sample its own CPU/memory, but the main
  // process owns the sockets, so a full picture needs both halves.
  ipcMain.handle(IPC.remote.benchSample, () => ({
    cpu: process.getCPUUsage().percentCPUUsage,
    memory: process.memoryUsage().rss,
    at: Date.now(),
  }));
}
