import { app, type BrowserWindow, dialog, ipcMain } from 'electron';
import type { OpenSessionSummary } from '../shared/apiTypes';
import { IPC } from '../shared/ipcChannels';
import {
  describeOpenSessions,
  hasOpenSessions,
  QUIT_CONFIRM_LABEL,
  QUIT_CONFIRM_TITLE,
} from '../shared/quitConfirmation';
import { openRdpSessionCount } from './ipc/rdp';
import { sendToWindow } from './ipc/send';
import { openSshSessionCount } from './ipc/ssh';
import { openCliSessionCount, terminalsKeepRunningAfterQuit } from './ipc/terminal';
import { getMainWindow } from './mainWindow';
import { activeFileSends } from './remote/send/active';
import { keepWindowsHidden } from './testMode';

/**
 * Closing the app while an agent CLI, an SSH connection, a Remote Desktop session or a file
 * transfer (E112) is open asks first. Once the user says yes (or nothing is open, or the quit is a restart the app
 * starts itself), every later close and quit in this run goes straight through.
 */

let allowed = false;
let asking: Promise<boolean> | null = null;
let answer: ((confirmed: boolean) => void) | null = null;

/** Lets the next quit through without asking: an update install, a relaunch, an OS shutdown. */
export function allowQuit(): void {
  allowed = true;
}

async function openSessionSummary(): Promise<OpenSessionSummary> {
  const clis = openCliSessionCount();
  return {
    clis,
    ssh: openSshSessionCount(),
    rdp: openRdpSessionCount(),
    fileSends: activeFileSends(),
    clisKeepRunning: clis > 0 && (await terminalsKeepRunningAfterQuit()),
  };
}

function nothingToAsk(): boolean {
  return (
    allowed ||
    openCliSessionCount() + openSshSessionCount() + openRdpSessionCount() + activeFileSends() === 0
  );
}

async function askNatively(summary: OpenSessionSummary): Promise<boolean> {
  const win = getMainWindow();
  const options = {
    type: 'question' as const,
    title: QUIT_CONFIRM_TITLE,
    message: QUIT_CONFIRM_TITLE,
    detail: describeOpenSessions(summary),
    buttons: [QUIT_CONFIRM_LABEL, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

function askInWindow(win: BrowserWindow, summary: OpenSessionSummary): Promise<boolean> {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible() && !keepWindowsHidden) win.show();
  win.focus();
  return new Promise((resolve) => {
    // A window that goes away mid-question can't answer; treat it as a no.
    const onClosed = (): void => resolve(false);
    win.once('closed', onClosed);
    answer = (confirmed) => {
      win.removeListener('closed', onClosed);
      resolve(confirmed);
    };
    sendToWindow(win, IPC.app.onConfirmQuit, summary);
  });
}

async function ask(): Promise<boolean> {
  const summary = await openSessionSummary();
  if (!hasOpenSessions(summary)) return true;
  const win = getMainWindow();
  // The styled dialog needs a live, loaded page to show it; anything else gets the OS one.
  const pageReady = win && !win.webContents.isLoading() && !win.webContents.isCrashed();
  return pageReady ? askInWindow(win, summary) : askNatively(summary);
}

/** Starts the question (or joins the one already showing) and quits if the user agrees. */
function askThenQuit(): void {
  if (asking) return;
  asking = ask()
    .catch(() => false)
    .finally(() => {
      asking = null;
      answer = null;
    });
  void asking.then((confirmed) => {
    if (!confirmed) return;
    allowed = true;
    app.quit();
  });
}

/**
 * For the main window's `close` event (on Windows and Linux closing it closes the app) and for
 * `before-quit`. Returns false when the close was held back to ask.
 */
export function guardQuit(event: Electron.Event): boolean {
  if (nothingToAsk()) return true;
  event.preventDefault();
  askThenQuit();
  return false;
}

export function registerQuitGuardHandlers(): void {
  ipcMain.handle(IPC.app.answerQuit, (_event, confirmed: boolean): void => {
    answer?.(confirmed === true);
  });
}
