import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppNotification } from '@runova/core';
import { app } from 'electron';
import type { ServerNotification } from '../../shared/dependencyAlerts';
import { IPC } from '../../shared/ipcChannels';
import type { AccountRuntime } from '../account/runtime';
import { appNotificationInbox } from '../deploy/watcher';
import { broadcastToWindows } from '../ipc/send';
import { showOsNotification } from '../notifications/osNotification';
import { readProjectInventory } from '../packageManagers';
import { store } from '../store';
import { websiteAlertHub } from './hub';
import { createDependencyAlerts, type DependencyAlerts } from './service';

/**
 * Dependency alerts bound to the real app (E51): the account's API and token, the projects store,
 * the inbox in app-notifications.json and the OS notification, and what was last sent up in
 * dependency-alerts.json under userData/data.
 */

function hashesFile(): string {
  return join(app.getPath('userData'), 'data', 'dependency-alerts.json');
}

/** The inbox entry for a server message: the project's Packages tab is where it leads. */
export function inboxEntry(
  notification: ServerNotification,
  project: { id: string; name: string } | null,
): AppNotification {
  return {
    id: `dependency:${notification.id}`,
    kind: 'dependency-updates',
    title: notification.title,
    body: notification.body,
    projectId: project?.id ?? null,
    projectName: project?.name ?? 'Packages',
    htmlUrl: null,
    route: project ? `/projects/${encodeURIComponent(project.id)}?tab=packages` : '/projects',
    createdAt: notification.createdAt,
    read: notification.readAt !== null,
  };
}

// biome-ignore lint/suspicious/noConsole: the only record of an upload or a connection that failed
const log = (message: string): void => console.warn(message);

export function liveDependencyAlerts(runtime: AccountRuntime): DependencyAlerts {
  const inbox = appNotificationInbox({
    list: () => store.getAppNotifications(),
    save: (items) => store.setAppNotifications(items),
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
    inbox: async (notification, project) => {
      const entry = inboxEntry(notification, project);
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
