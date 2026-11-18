import { dialog, ipcMain, type OpenDialogOptions, shell } from 'electron';
import { parseRemoteId } from '../../shared/anywhere';
import {
  EMPTY_FILE_SEND_STATE,
  type FileSendState,
  type ReceiveFrom,
  type SendAnswer,
  type SendRequest,
  type SendSettingsPatch,
  type StageResult,
} from '../../shared/fileSend';
import { IPC } from '../../shared/ipcChannels';
import { getAccountRuntime } from '../account/live';
import { getMainWindow } from '../mainWindow';
import { fileSendState, getFileSend } from '../remote/anywhere/live';
import { signedInOnly } from './remoteSignIn';

const files = () => getFileSend(getAccountRuntime());

/** More than this many dropped or picked at once is a mistake, not a send. */
const MAX_STAGED = 1_000;
const NOTE_MAX = 500;
const RECEIVE_FROM: readonly ReceiveFrom[] = ['everyone', 'own', 'nobody'];

/** Folders picked for one offer, by batch, so the answer never takes a folder from the screen. */
const chosenFolders = new Map<string, string>();

function pathList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Expected a list of files and folders.');
  return value
    .filter(
      (path): path is string => typeof path === 'string' && path.length > 0 && path.length < 4_096,
    )
    .slice(0, MAX_STAGED);
}

async function openDialog(options: OpenDialogOptions): Promise<string[] | null> {
  const window = getMainWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
}

async function pick(kind: 'files' | 'folders'): Promise<StageResult | null> {
  const paths = await openDialog(
    kind === 'files'
      ? { title: 'Choose files to send', properties: ['openFile', 'multiSelections'] }
      : { title: 'Choose folders to send', properties: ['openDirectory', 'multiSelections'] },
  );
  return paths ? files().stage(paths) : null;
}

async function pickFolder(title: string): Promise<string | null> {
  const paths = await openDialog({ title, properties: ['openDirectory', 'createDirectory'] });
  return paths?.[0] ?? null;
}

function sendRequest(value: unknown): SendRequest {
  const input = (value ?? {}) as { remoteId?: unknown; note?: unknown };
  const remoteId = parseRemoteId(typeof input.remoteId === 'string' ? input.remoteId : '');
  if (!remoteId) throw new Error('Enter a 9-digit Runova ID.');
  const note =
    typeof input.note === 'string' ? [...input.note.trim()].slice(0, NOTE_MAX).join('') : '';
  return note ? { remoteId, note } : { remoteId };
}

function settingsPatch(value: unknown): SendSettingsPatch {
  const input = (value ?? {}) as Record<string, unknown>;
  const patch: SendSettingsPatch = {};
  if (RECEIVE_FROM.includes(input.receiveFrom as ReceiveFrom)) {
    patch.receiveFrom = input.receiveFrom as ReceiveFrom;
  }
  if (typeof input.autoAcceptOwn === 'boolean') patch.autoAcceptOwn = input.autoAcceptOwn;
  // A folder is only ever set through the picker; the screen may only go back to Downloads.
  if (input.saveFolder === null) patch.saveFolder = null;
  return patch;
}

/** Sending files to your other devices and teammates (E112): the screens' calls. */
export function registerFileSendHandlers(): void {
  ipcMain.handle(
    IPC.fileSend.getState,
    (): FileSendState => (fileSendState() as FileSendState | null) ?? EMPTY_FILE_SEND_STATE,
  );
  ipcMain.handle(
    IPC.fileSend.stagePaths,
    signedInOnly((paths: unknown) => files().stage(pathList(paths))),
  );
  ipcMain.handle(
    IPC.fileSend.pickFiles,
    signedInOnly(() => pick('files')),
  );
  ipcMain.handle(
    IPC.fileSend.pickFolder,
    signedInOnly(() => pick('folders')),
  );
  ipcMain.handle(IPC.fileSend.unstage, (_e, ids: unknown) =>
    files().unstage(ids === 'all' ? 'all' : pathList(ids)),
  );
  ipcMain.handle(
    IPC.fileSend.send,
    signedInOnly((request: unknown) => files().send(sendRequest(request))),
  );
  ipcMain.handle(IPC.fileSend.cancel, (_e, batchId: string) => files().cancel(String(batchId)));
  ipcMain.handle(IPC.fileSend.cancelFile, (_e, batchId: string, transferId: string) =>
    files().cancelFile(String(batchId), String(transferId)),
  );
  ipcMain.handle(
    IPC.fileSend.retry,
    signedInOnly((batchId: string) => files().retry(String(batchId))),
  );
  ipcMain.handle(IPC.fileSend.dismiss, (_e, batchId: string) => files().dismiss(String(batchId)));
  ipcMain.handle(IPC.fileSend.clearFinished, () => files().clearFinished());
  ipcMain.handle(
    IPC.fileSend.respond,
    signedInOnly((batchId: string, answer: SendAnswer) => {
      const id = String(batchId);
      const folder = chosenFolders.get(id);
      chosenFolders.delete(id);
      return files().respond(id, {
        accept: answer?.accept === true,
        alwaysAcceptOwn: answer?.alwaysAcceptOwn === true,
        ...(folder ? { folder } : {}),
      });
    }),
  );
  ipcMain.handle(
    IPC.fileSend.chooseFolder,
    signedInOnly(async (batchId: string) => {
      const folder = await pickFolder('Save these files in');
      if (folder) chosenFolders.set(String(batchId), folder);
      return folder;
    }),
  );
  ipcMain.handle(
    IPC.fileSend.chooseSaveFolder,
    signedInOnly(async () => {
      const folder = await pickFolder('Save received files in');
      if (folder) await files().updateSettings({ saveFolder: folder });
      return folder;
    }),
  );
  ipcMain.handle(
    IPC.fileSend.updateSettings,
    signedInOnly((patch: unknown) => files().updateSettings(settingsPatch(patch))),
  );
  ipcMain.handle(IPC.fileSend.showInFolder, async (_e, batchId: string, transferId?: string) => {
    const path = files().savedPathOf(String(batchId), transferId ? String(transferId) : undefined);
    if (!path) return;
    if (transferId) shell.showItemInFolder(path);
    else await shell.openPath(path);
  });
  ipcMain.handle(IPC.fileSend.openFile, async (_e, batchId: string, transferId: string) => {
    const path = files().savedPathOf(String(batchId), String(transferId));
    if (path) await shell.openPath(path);
  });
  ipcMain.handle(IPC.fileSend.openApp, () => {
    const window = getMainWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send(IPC.app.onNavigate, '/remote?tab=send');
  });
}
