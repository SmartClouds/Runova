import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { ServerNotification } from '../../shared/dependencyAlerts';
import { IPC } from '../../shared/ipcChannels';
import type { AccountRuntime } from '../account/runtime';
import { appNotificationInbox } from '../deploy/watcher';
import { getCloudMonitors } from '../health/cloudLive';
import { readHealthTargets } from '../health/store';
import { broadcastToWindows } from '../ipc/send';
import { showOsNotification } from '../notifications/osNotification';
import { readProjectInventory } from '../packageManagers';
import { store } from '../store';
import { websiteAlertHub } from './hub';
import { type InboxMonitor, inboxEntry, isMonitorMessage } from './inbox';
import { createDependencyAlerts, type DependencyAlerts } from './service';

/**
 * Dependency alerts bound to the real app (E51): the account's API and token, the projects store,
 * the inbox in app-notifications.json and the OS notification, and what was last sent up in
 * dependency-alerts.json under userData/data.
 */

function hashesFile(): string {
  return join(app.getPath('userData'), 'data', 'dependency-alerts.json');
}

// biome-ignore lint/suspicious/noConsole: the only record of an upload or a connection that failed
const log = (message: string): void => console.warn(message);

/** The desktop monitor and its project an online monitor's message names, when this computer has it. */
async function monitorOf(notification: ServerNotification): Promise<InboxMonitor | null> {
  if (!isMonitorMessage(notification) || !notification.itemId) return null;
  const target = (await readHealthTargets()).find((one) => one.id === notification.itemId);
  if (!target) return null;
  const project = (await store.getProjects()).find((one) => one.id === target.projectId);
  return {
    targetId: target.id,
    projectId: target.projectId,
    projectName: project?.name ?? 'Monitoring',
  };
}

export function liveDependencyAlerts(runtime: AccountRuntime): DependencyAlerts {
  const inbox = appNotificationInbox({
    update: (change) => store.updateAppNotifications(change),
    changed: () => broadcastToWindows(IPC.appNotifications.onChanged),
  });

  return createDependencyAlerts({
    api: (method, path, body, options) => runtime.api(method, path, body, options),
    signedIn: async () => (await runtime.status()).state === 'signed-in',
    projects: async () =>
      (await store.getProjects())
        .filter((project) => !project.archived)
        .map((project) => ({ id: project.id, name: project.name, folderPath: project.folderPath })),
    placements: () => runtime.projectPlacements(),
    readInventory: readProjectInventory,
    hashes: {
      read: async () => {
        try {
          const parsed = JSON.parse(await readFile(hashesFile(), 'utf-8')) as { sent?: unknown };
          return parsed.sent && typeof parsed.sent === 'object'
            ? (parsed.sent as Record<string, string>)
            : {};
        } catch {
          return {};
        }
      },
      write: async (sent) => {
        const file = hashesFile();
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ sent }, null, 2), 'utf-8');
        await rename(temp, file);
      },
    },
    hub: () =>
      websiteAlertHub({
        siteUrl: runtime.siteUrl,
        accessToken: () => runtime.accessToken(),
        log,
      }),
    // The online monitors listen on the same connection (E56).
    attach: (hub) => {
      const cloud = getCloudMonitors();
      const failed = (error: unknown) => log(`[cloud-monitors] ${String(error)}`);
      hub.onCloudMonitorUpdated?.((monitor) => void cloud.live(monitor).catch(failed));
      hub.onCloudMonitorsChanged?.(() => void cloud.refresh().catch(failed));
      hub.onReconnected(() => void cloud.refresh().catch(failed));
      void cloud.refresh().catch(failed);
    },
    inbox: async (notification, project) => {
      const entry = inboxEntry(notification, project, await monitorOf(notification));
      // A message the app already has (caught up again after a restart) is not said twice.
      if ((await store.getAppNotifications()).some((item) => item.id === entry.id)) return;
      await inbox.add(entry);
      if (!entry.read)
        showOsNotification({
          title: entry.title,
          body: entry.body,
          route: entry.route ?? '/projects',
        });
    },
    changed: (summary) => broadcastToWindows(IPC.dependencyAlerts.onChanged, summary),
    log,
  });
}
