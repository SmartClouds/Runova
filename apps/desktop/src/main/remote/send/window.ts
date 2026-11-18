import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { appIcon } from '../../appIcon';
import { keepWindowsHidden } from '../../testMode';

/**
 * The window that asks the person here about files someone offers them (E112). Like Anywhere's
 * request window it stays on top of everything, so an offer is seen with Runova minimized or
 * behind other windows, and it takes focus, since someone is waiting on an answer.
 */

const SIZE = { width: 460, height: 560 };

let offerWindow: BrowserWindow | null = null;

function load(window: BrowserWindow, route: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route });
  }
}

/** Shows the window while offers wait for an answer, and closes it when none do. */
export function syncOfferWindow(waiting: number): void {
  if (waiting === 0) {
    offerWindow?.close();
    offerWindow = null;
    return;
  }
  if (offerWindow && !offerWindow.isDestroyed()) {
    if (!keepWindowsHidden) {
      offerWindow.show();
      offerWindow.focus();
    }
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...SIZE,
    x: Math.round(area.x + (area.width - SIZE.width) / 2),
    y: Math.round(area.y + (area.height - SIZE.height) / 3),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Incoming files',
    backgroundColor: '#0b0f0e',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.once('ready-to-show', () => {
    if (keepWindowsHidden) return;
    window.show();
    window.focus();
  });
  window.on('closed', () => {
    if (offerWindow === window) offerWindow = null;
  });
  load(window, '/incoming-files');
  offerWindow = window;
}

export function offerWindows(): BrowserWindow[] {
  return offerWindow && !offerWindow.isDestroyed() ? [offerWindow] : [];
}
