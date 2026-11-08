import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { appIcon } from '../../appIcon';
import { keepWindowsHidden } from '../../testMode';

/**
 * Runova Anywhere's two small windows on the host (E61), both on top of everything:
 *
 * - The request window asks the person at this computer about a connection, even when Runova is
 *   minimized or behind other windows. It takes focus, since someone is waiting on an answer.
 * - The host bar sits at the top of the screen for as long as anyone is connected, says who, and
 *   ends the session with one click. It never takes focus from what the person is doing.
 */

const REQUEST_SIZE = { width: 440, height: 380 };
const BAR_SIZE = { width: 560, height: 56 };

let requestWindow: BrowserWindow | null = null;
let barWindow: BrowserWindow | null = null;

function load(window: BrowserWindow, route: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route });
  }
}

function webPreferences() {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
  };
}

/** Shows the request window while requests wait for an answer, and closes it when none do. */
export function syncRequestWindow(waiting: number): void {
  if (waiting === 0) {
    requestWindow?.close();
    return;
  }
  if (requestWindow && !requestWindow.isDestroyed()) {
    if (!keepWindowsHidden) {
      requestWindow.show();
      requestWindow.focus();
    }
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...REQUEST_SIZE,
    x: Math.round(area.x + (area.width - REQUEST_SIZE.width) / 2),
    y: Math.round(area.y + (area.height - REQUEST_SIZE.height) / 3),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Runova Anywhere request',
    backgroundColor: '#0b0f0e',
    icon: appIcon,
    webPreferences: webPreferences(),
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.once('ready-to-show', () => {
    if (keepWindowsHidden) return;
    window.show();
    window.focus();
  });
  window.on('closed', () => {
    if (requestWindow === window) requestWindow = null;
  });
  load(window, '/anywhere-request');
  requestWindow = window;
}

/** Shows the host bar while anyone is connected to this computer. */
export function syncHostBar(sessions: number): void {
  if (sessions === 0) {
    barWindow?.close();
    return;
  }
  if (barWindow && !barWindow.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...BAR_SIZE,
    x: Math.round(area.x + (area.width - BAR_SIZE.width) / 2),
    y: area.y + 8,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Runova Anywhere session',
    icon: appIcon,
    webPreferences: webPreferences(),
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.once('ready-to-show', () => {
    if (!keepWindowsHidden) window.showInactive();
  });
  window.on('closed', () => {
    if (barWindow === window) barWindow = null;
  });
  load(window, '/anywhere-bar');
  barWindow = window;
}

export function anywhereWindows(): BrowserWindow[] {
  return [requestWindow, barWindow].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
}
