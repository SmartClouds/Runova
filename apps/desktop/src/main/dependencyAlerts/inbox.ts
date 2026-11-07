import type { AppNotification } from '@runova/core';
import type { ServerNotification } from '../../shared/dependencyAlerts';
import { healthRoute } from '../health/alerts';

/** The online monitor messages (E56): down, back up, and changed by the account type. */
const MONITOR_KINDS = new Set(['monitor-down', 'monitor-recovered', 'monitor-plan']);

/** The monitor a server message is about: its item id is the desktop monitor's id. */
export interface InboxMonitor {
  targetId: string;
  projectId: string;
  projectName: string;
}

/**
 * The inbox entry for a server message: the project's Packages tab for a dependency alert, the
 * monitor on the Monitoring page for an online monitor's.
 */
export function inboxEntry(
  notification: ServerNotification,
  project: { id: string; name: string } | null,
  monitor: InboxMonitor | null = null,
): AppNotification {
  if (MONITOR_KINDS.has(notification.kind)) {
    return {
      id: `monitor:${notification.id}`,
      kind: notification.kind === 'monitor-recovered' ? 'health-recovered' : 'health-failure',
      title: notification.title,
      body: notification.body,
      projectId: monitor?.projectId ?? null,
      projectName: monitor?.projectName ?? 'Monitoring',
      htmlUrl: null,
      route:
        monitor && notification.kind !== 'monitor-plan'
          ? healthRoute(monitor.targetId)
          : '/monitoring',
      createdAt: notification.createdAt,
      read: notification.readAt !== null,
    };
  }
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

/** True for the online monitor messages. */
export function isMonitorMessage(notification: ServerNotification): boolean {
  return MONITOR_KINDS.has(notification.kind);
}
