import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { FileSendState } from '../../../shared/fileSend';
import { IPC } from '../../../shared/ipcChannels';
import { sendToWindow } from '../../ipc/send';
import { getMainWindow } from '../../mainWindow';
import { showOsNotification } from '../../notifications/osNotification';
import { keepAwake } from '../../power/keepAwake';
import type { AnywhereService } from '../anywhere/service';
import { cleanStalePartFiles } from '../fileTransfer';
import { setActiveFileSends } from './active';
import { createSendService, type SendService } from './service';
import { offerWindows, syncOfferWindow } from './window';

/** Part files older than this are what a crash or a hard quit left behind. */
const STALE_PART_MS = 24 * 3600_000;

export interface LiveSendService {
  service: SendService;
  lastState(): FileSendState | null;
  /** The Anywhere state changed: devices, presence or settings. */
  anywhereChanged(saveFolder: string | null): void;
}

/** The app's one send service (E112), over the app's Runova Anywhere service. */
export function createLiveSendService(
  anywhere: AnywhereService,
  log: (message: string) => void,
): LiveSendService {
  let last: FileSendState | null = null;
  const cleaned = new Set<string>();

  const clean = (folder: string): void => {
    if (cleaned.has(folder)) return;
    cleaned.add(folder);
    void cleanStalePartFiles(join(folder, '.runova-partial'), STALE_PART_MS);
  };

  const service = createSendService({
    anywhere: {
      state: () => anywhere.state(),
      dial: (remoteId, intent) => anywhere.dial(remoteId, intent),
      updateSettings: (patch) => anywhere.updateSettings(patch),
    },
    defaultSaveFolder: () => app.getPath('downloads'),
    announce: (state) => {
      last = state;
      for (const window of [getMainWindow(), ...offerWindows()]) {
        sendToWindow(window, IPC.fileSend.onState, state);
      }
      syncOfferWindow(state.offers.length);
    },
    showOffer: () => syncOfferWindow(Math.max(1, last?.offers.length ?? 0)),
    notify: (title, body) => {
      // The window says it already when Runova is in front.
      if (BrowserWindow.getFocusedWindow()) return;
      showOsNotification({ title, body, route: '/remote?tab=send' });
    },
    busy: (active) => keepAwake.setBusy('send', active),
    log,
  });

  setActiveFileSends({
    count: () => service.activeCount(),
    stopForQuit: () => service.cancelAllForQuit(),
  });
  clean(app.getPath('downloads'));

  return {
    service,
    lastState: () => last,
    anywhereChanged: (saveFolder) => {
      if (saveFolder) clean(saveFolder);
      service.refresh();
    },
  };
}
