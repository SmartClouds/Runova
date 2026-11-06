import { createHash } from 'node:crypto';
import {
  type DependencyAlertSettings,
  type DependencyAlertsSummary,
  type DependencyFindingsView,
  EMPTY_DEPENDENCY_SUMMARY,
  type InventoryPackage,
  type ServerNotification,
  type TelegramLinkView,
} from '../../shared/dependencyAlerts';

/**
 * Dependency alerts on this computer (E51). The server does the daily checks, so the app has two
 * jobs: send each project's package list up when it changes, and listen for what the server
 * finds. It reads the packages from the manifests only (no CLI, no network) and sends a project
 * again only when its list or its scope changed. It keeps one connection to the notifications
 * hub while signed in, and catches up on unread messages each time that connection opens.
 */

export interface AlertHub {
  start(): Promise<void>;
  stop(): Promise<void>;
  onNotification(handler: (notification: ServerNotification) => void): void;
  onSummaryChanged(handler: () => void): void;
  onReconnected(handler: () => void): void;
}

export interface AlertProject {
  id: string;
  name: string;
  folderPath: string;
}

export interface DependencyAlertsDeps {
  api: <T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { headers?: Record<string, string> },
  ) => Promise<T>;
  signedIn: () => Promise<boolean>;
  projects: () => Promise<AlertProject[]>;
  /** The scope each project lives in now: the account's own, or its team's. */
  placements: () => Promise<Map<string, { scopeId: number; canWrite: boolean }>>;
  readInventory: (folderPath: string) => Promise<InventoryPackage[]>;
  /** What was sent last, by `scopeId:projectId`, kept across restarts. */
  hashes: {
    read: () => Promise<Record<string, string>>;
    write: (hashes: Record<string, string>) => Promise<void>;
  };
  hub: () => AlertHub;
  /** Puts a message in the app's inbox (and says it, the first time). */
  inbox: (
    notification: ServerNotification,
    project: { id: string; name: string } | null,
  ) => Promise<void>;
  /** Tells the windows the findings changed. */
  changed: (summary: DependencyAlertsSummary) => void;
  log?: (message: string) => void;
}

export const UPLOAD_EVERY_MS = 6 * 60 * 60 * 1000;
export const REFRESH_EVERY_MS = 30 * 60 * 1000;
const CATCH_UP_PAGE = 50;

function hashOf(projectName: string, packages: InventoryPackage[]): string {
  return createHash('sha256').update(JSON.stringify({ projectName, packages })).digest('hex');
}

function summarize(view: DependencyFindingsView): DependencyAlertsSummary {
  const byProject = Object.fromEntries(view.items.map((item) => [item.itemId, item]));
  const live = view.items.filter((item) => !item.muted && item.total > 0);
  return {
    signedIn: true,
    enabled: view.enabled,
    projectsWithAlerts: live.length,
    total: live.reduce((sum, item) => sum + item.total, 0),
    byProject,
  };
}

export function createDependencyAlerts(deps: DependencyAlertsDeps) {
  const log = deps.log ?? (() => undefined);
  let current: DependencyAlertsSummary | null = null;
  let hub: AlertHub | null = null;
  let uploading: Promise<{ uploaded: number; skipped: number }> | null = null;
  const timers: NodeJS.Timeout[] = [];

  function announce(summary: DependencyAlertsSummary): DependencyAlertsSummary {
    current = summary;
    deps.changed(summary);
    return summary;
  }

  async function refresh(): Promise<DependencyAlertsSummary> {
    if (!(await deps.signedIn())) return announce(EMPTY_DEPENDENCY_SUMMARY);
    return announce(
      summarize(await deps.api<DependencyFindingsView>('GET', '/dependency-findings')),
    );
  }

  async function projectsById(): Promise<Map<string, AlertProject>> {
    return new Map((await deps.projects()).map((project) => [project.id, project]));
  }

  async function catchUp(): Promise<void> {
    const page = await deps.api<{ items: ServerNotification[] }>(
      'GET',
      `/notifications?unread=true&pageSize=${CATCH_UP_PAGE}`,
    );
    const projects = await projectsById();
    // Oldest first, so the inbox ends up in the order they came.
    for (const notification of [...page.items].reverse()) await deliver(notification, projects);
  }

  async function deliver(
    notification: ServerNotification,
    projects?: Map<string, AlertProject>,
  ): Promise<void> {
    const known = projects ?? (await projectsById());
    const project = notification.itemId ? known.get(notification.itemId) : undefined;
    await deps.inbox(notification, project ? { id: project.id, name: project.name } : null);
  }

  async function uploadAll(): Promise<{ uploaded: number; skipped: number }> {
    if (!(await deps.signedIn())) return { uploaded: 0, skipped: 0 };
    const summary = current ?? (await refresh());
    if (!summary.enabled) return { uploaded: 0, skipped: 0 };

    const [projects, placements, sent] = await Promise.all([
      deps.projects(),
      deps.placements(),
      deps.hashes.read(),
    ]);
    const hashes = { ...sent };
    let uploaded = 0;
    let skipped = 0;
    for (const project of projects) {
      const place = placements.get(project.id);
      if (!project.folderPath.trim() || !place?.canWrite) {
        skipped++;
        continue;
      }
      const packages = await deps.readInventory(project.folderPath).catch(() => []);
      const key = `${place.scopeId}:${project.id}`;
      const hash = hashOf(project.name, packages);
      if (packages.length === 0 || hashes[key] === hash) {
        skipped++;
        continue;
      }
      try {
        // A project that moved into or out of a team leaves its old copy behind otherwise.
        for (const old of Object.keys(hashes).filter(
          (k) => k !== key && k.endsWith(`:${project.id}`),
        )) {
          const [scopeId] = old.split(':');
          await deps
            .api(
              'DELETE',
              `/sync-scopes/${scopeId}/package-inventories/${encodeURIComponent(project.id)}`,
            )
            .catch(() => undefined);
          delete hashes[old];
        }
        await deps.api(
          'PUT',
          `/sync-scopes/${place.scopeId}/package-inventories/${encodeURIComponent(project.id)}`,
          {
            projectName: project.name,
            packages,
          },
        );
        hashes[key] = hash;
        uploaded++;
      } catch (error) {
        skipped++;
        log(`[dependency-alerts] could not send the packages of ${project.name}: ${String(error)}`);
      }
    }
    await deps.hashes.write(hashes);
    return { uploaded, skipped };
  }

  function upload(): Promise<{ uploaded: number; skipped: number }> {
    uploading ??= uploadAll().finally(() => {
      uploading = null;
    });
    return uploading;
  }

  function background(task: () => Promise<unknown>, what: string): void {
    task().catch((error: unknown) => log(`[dependency-alerts] ${what} failed: ${String(error)}`));
  }

  function inventoryIdOf(projectId: string): number {
    const found = current?.byProject[projectId];
    if (!found) throw new Error('This project has not been checked yet.');
    return found.inventoryId;
  }

  return {
    summary: (): DependencyAlertsSummary => current ?? EMPTY_DEPENDENCY_SUMMARY,
    refresh,
    upload,

    async start(): Promise<void> {
      if (hub || !(await deps.signedIn())) return;
      const connection = deps.hub();
      hub = connection;
      connection.onNotification((notification) =>
        background(() => deliver(notification), 'a message'),
      );
      connection.onSummaryChanged(() => background(refresh, 'reading the findings'));
      connection.onReconnected(() =>
        background(() => Promise.all([catchUp(), refresh()]), 'catching up'),
      );
      try {
        await connection.start();
      } catch (error) {
        // The timers below keep the findings fresh until the hub can be reached.
        log(`[dependency-alerts] the notifications hub could not be reached: ${String(error)}`);
      }
      await Promise.all([catchUp(), refresh()]).catch((error: unknown) =>
        log(`[dependency-alerts] catching up failed: ${String(error)}`),
      );
      background(upload, 'sending packages');
      timers.push(setInterval(() => background(upload, 'sending packages'), UPLOAD_EVERY_MS));
      timers.push(setInterval(() => background(refresh, 'reading the findings'), REFRESH_EVERY_MS));
    },

    async stop(): Promise<void> {
      for (const timer of timers.splice(0)) clearInterval(timer);
      const connection = hub;
      hub = null;
      await connection?.stop().catch(() => undefined);
      current = null;
      deps.changed(EMPTY_DEPENDENCY_SUMMARY);
    },

    settings: () =>
      deps.api<DependencyAlertSettings>('GET', '/accounts/me/dependency-alert-settings'),

    async updateSettings(
      patch: Partial<DependencyAlertSettings>,
    ): Promise<DependencyAlertSettings> {
      // The app only ever sends the fields the person just changed, so the newest copy wins.
      const settings = await deps.api<DependencyAlertSettings>(
        'PATCH',
        '/accounts/me/dependency-alert-settings',
        patch,
        { headers: { 'if-match': '*' } },
      );
      await refresh();
      if (patch.enabled === true) {
        await deps.hashes.write({});
        background(upload, 'sending packages');
      }
      return settings;
    },

    async mute(projectId: string, muted: boolean): Promise<DependencyAlertsSummary> {
      await deps.api(
        muted ? 'PUT' : 'DELETE',
        `/accounts/me/muted-projects/${inventoryIdOf(projectId)}`,
      );
      return refresh();
    },

    telegramLink: () => deps.api<TelegramLinkView>('GET', '/accounts/me/telegram-links/current'),
    telegramLinkCode: () =>
      deps.api<{ url: string; expiresAt: string }>('POST', '/accounts/me/telegram-link-codes'),
    telegramUnlink: () => deps.api<void>('DELETE', '/accounts/me/telegram-links/current'),
  };
}

export type DependencyAlerts = ReturnType<typeof createDependencyAlerts>;
