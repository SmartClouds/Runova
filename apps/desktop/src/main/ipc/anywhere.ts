import { ipcMain, shell, systemPreferences } from 'electron';
import {
  type AnywhereConnectRequest,
  type AnywhereIncomingAnswer,
  type AnywhereSettingsPatch,
  type AnywhereState,
  EMPTY_ANYWHERE_STATE,
} from '../../shared/anywhere';
import { IPC } from '../../shared/ipcChannels';
import { getAccountRuntime } from '../account/live';
import { getMainWindow } from '../mainWindow';
import { anywhereLinks, anywhereState, getAnywhere } from '../remote/anywhere/live';

const anywhere = () => getAnywhere(getAccountRuntime());

/** Runova Anywhere (E61): the screens' calls, and the main window's WebRTC peer reporting back. */
export function registerAnywhereHandlers(): void {
  ipcMain.handle(
    IPC.anywhere.getState,
    (): AnywhereState => anywhereState() ?? EMPTY_ANYWHERE_STATE,
  );
  ipcMain.handle(IPC.anywhere.connect, (_e, request: AnywhereConnectRequest) =>
    anywhere().connect(request),
  );
  ipcMain.handle(IPC.anywhere.submitPassword, (_e, password: string, save: boolean) =>
    anywhere().submitPassword(password, save),
  );
  ipcMain.handle(IPC.anywhere.trustNewKey, () => anywhere().trustNewKey());
  ipcMain.handle(IPC.anywhere.disconnect, () => anywhere().disconnect());
  ipcMain.handle(
    IPC.anywhere.respondIncoming,
    (_e, sessionId: string, answer: AnywhereIncomingAnswer) =>
      anywhere().respondIncoming(sessionId, answer),
  );
  ipcMain.handle(IPC.anywhere.endHosted, (_e, sessionId: string) =>
    anywhere().endHosted(sessionId),
  );
  ipcMain.handle(IPC.anywhere.pauseInput, (_e, paused: boolean) => anywhere().pauseInput(paused));
  ipcMain.handle(IPC.anywhere.updateSettings, (_e, patch: AnywhereSettingsPatch) =>
    anywhere().updateSettings(patch),
  );
  ipcMain.handle(IPC.anywhere.setPassword, (_e, password: string | null) =>
    anywhere().setPassword(password),
  );
  ipcMain.handle(IPC.anywhere.refresh, () => anywhere().refresh());
  ipcMain.handle(IPC.anywhere.history, () => anywhere().history());
  ipcMain.handle(IPC.anywhere.deleteHistory, (_e, id: number) => anywhere().deleteHistory(id));
  ipcMain.handle(IPC.anywhere.forgetRecent, (_e, remoteId: string) =>
    anywhere().forgetRecent(remoteId),
  );
  ipcMain.handle(IPC.anywhere.forgetSavedPassword, (_e, remoteId: string) =>
    anywhere().forgetSavedPassword(remoteId),
  );
  ipcMain.handle(IPC.anywhere.openApp, () => {
    const window = getMainWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send(IPC.app.onNavigate, '/remote?tab=anywhere');
  });

  ipcMain.handle(IPC.anywhere.grantPermission, async (_e, kind: 'accessibility' | 'screen') => {
    if (process.platform !== 'darwin') return;
    // Asking once shows macOS's own prompt; after that only System Settings can change it.
    if (kind === 'accessibility' && systemPreferences.isTrustedAccessibilityClient(true)) return;
    const pane = kind === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    await anywhere().refresh();
  });
  ipcMain.on(IPC.anywhere.linkSignal, (_e, sessionId: string, payload: string) =>
    anywhereLinks()?.rendererSignal(sessionId, payload),
  );
  ipcMain.on(
    IPC.anywhere.linkOpened,
    (_e, sessionId: string, fingerprints: { local: string; remote: string }) =>
      anywhereLinks()?.rendererOpened(sessionId, fingerprints),
  );
  ipcMain.on(IPC.anywhere.linkFrame, (_e, sessionId: string, frame: Uint8Array) =>
    anywhereLinks()?.rendererFrame(
      sessionId,
      frame instanceof Uint8Array ? frame : new Uint8Array(frame),
    ),
  );
  ipcMain.on(IPC.anywhere.linkBuffered, (_e, sessionId: string, amount: number) =>
    anywhereLinks()?.rendererBuffered(sessionId, amount),
  );
  ipcMain.on(IPC.anywhere.linkClosed, (_e, sessionId: string, reason: string) =>
    anywhereLinks()?.rendererClosed(sessionId, reason),
  );
}
