import { ipcMain, shell } from 'electron';
import type {
  DependencyAlertSettings,
  DependencyAlertsSummary,
  SecurityThreshold,
  TelegramLinkView,
} from '../../shared/dependencyAlerts';
import { IPC } from '../../shared/ipcChannels';
import { getDependencyAlerts } from '../account/live';

const FLAGS = ['enabled', 'deprecated', 'major', 'minor', 'patch', 'inApp', 'telegram'] as const;
const THRESHOLDS: SecurityThreshold[] = ['critical', 'high', 'moderate', 'low', 'off'];

/** Only the known fields, each of its own type, reach the server. */
export function cleanSettingsPatch(input: unknown): Partial<DependencyAlertSettings> {
  if (!input || typeof input !== 'object') throw new Error('Send the settings to change.');
  const patch: Partial<DependencyAlertSettings> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((FLAGS as readonly string[]).includes(key) && typeof value === 'boolean') {
      patch[key as (typeof FLAGS)[number]] = value;
    } else if (key === 'securityMinSeverity' && THRESHOLDS.includes(value as SecurityThreshold)) {
      patch.securityMinSeverity = value as SecurityThreshold;
    } else {
      throw new Error(`${key} is not a dependency alert setting.`);
    }
  }
  return patch;
}

const TELEGRAM_LINK = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]{1,64}$/;

export function registerDependencyAlertHandlers(): void {
  ipcMain.handle(
    IPC.dependencyAlerts.summary,
    (): DependencyAlertsSummary => getDependencyAlerts().summary(),
  );
  ipcMain.handle(
    IPC.dependencyAlerts.refresh,
    (): Promise<DependencyAlertsSummary> => getDependencyAlerts().refresh(),
  );
  ipcMain.handle(
    IPC.dependencyAlerts.settings,
    (): Promise<DependencyAlertSettings> => getDependencyAlerts().settings(),
  );
  ipcMain.handle(
    IPC.dependencyAlerts.updateSettings,
    (_event, patch: unknown): Promise<DependencyAlertSettings> =>
      getDependencyAlerts().updateSettings(cleanSettingsPatch(patch)),
  );
  ipcMain.handle(
    IPC.dependencyAlerts.mute,
    (_event, projectId: unknown, muted: unknown): Promise<DependencyAlertsSummary> => {
      if (typeof projectId !== 'string' || typeof muted !== 'boolean')
        throw new Error('Name the project and whether to mute it.');
      return getDependencyAlerts().mute(projectId, muted);
    },
  );
  ipcMain.handle(
    IPC.dependencyAlerts.telegramLink,
    (): Promise<TelegramLinkView> => getDependencyAlerts().telegramLink(),
  );
  /** Opens the bot with a one-time code in the browser; only a t.me link of that shape is opened. */
  ipcMain.handle(IPC.dependencyAlerts.telegramConnect, async (): Promise<void> => {
    const { url } = await getDependencyAlerts().telegramLinkCode();
    if (!TELEGRAM_LINK.test(url))
      throw new Error('The server sent a link that is not a Telegram bot link.');
    await shell.openExternal(url);
  });
  ipcMain.handle(
    IPC.dependencyAlerts.telegramUnlink,
    (): Promise<void> => getDependencyAlerts().telegramUnlink(),
  );
}
