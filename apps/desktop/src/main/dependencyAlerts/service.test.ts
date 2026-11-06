import { describe, expect, it, vi } from 'vitest';
import type {
  DependencyAlertsSummary,
  DependencyFindingsView,
  InventoryPackage,
  ProjectFindings,
  ServerNotification,
} from '../../shared/dependencyAlerts';
import { type AlertHub, createDependencyAlerts, type DependencyAlertsDeps } from './service';

const LODASH: InventoryPackage = {
  ecosystem: 'npm',
  name: 'lodash',
  version: '4.17.20',
  dev: false,
};

function findingsFor(itemId: string, total: number, muted = false): ProjectFindings {
  return {
    inventoryId: 7,
    scopeId: 1,
    itemId,
    projectName: 'Shop',
    muted,
    lastCheckedAt: '2026-11-06T09:00:00.000Z',
    total,
    worstSeverity: total > 0 ? 'high' : null,
    counts: { security: total, deprecated: 0, major: 0, minor: 0, patch: 0 },
    findings: [],
  };
}

function notification(id: number, itemId: string | null = 'p-shop'): ServerNotification {
  return {
    id,
    kind: 'dependency-updates',
    title: 'Security fix for lodash in Shop',
    body: 'lodash 4.17.20 to 4.17.21: high security issue',
    severity: 'high',
    scopeId: 1,
    itemId,
    inventoryId: 7,
    createdAt: '2026-11-06T09:00:00.000Z',
    readAt: null,
  };
}

/** A hub the test drives: it pushes what the server would. */
function fakeHub() {
  const handlers = {
    notification: [] as ((n: ServerNotification) => void)[],
    summary: [] as (() => void)[],
    reconnected: [] as (() => void)[],
  };
  const hub: AlertHub & { started: number; stopped: number } = {
    started: 0,
    stopped: 0,
    async start() {
      hub.started++;
    },
    async stop() {
      hub.stopped++;
    },
    onNotification: (h) => handlers.notification.push(h),
    onSummaryChanged: (h) => handlers.summary.push(h),
    onReconnected: (h) => handlers.reconnected.push(h),
  };
  return {
    hub,
    push: (n: ServerNotification) => {
      for (const h of handlers.notification) h(n);
    },
    summaryChanged: () => {
      for (const h of handlers.summary) h();
    },
    reconnect: () => {
      for (const h of handlers.reconnected) h();
    },
  };
}

interface Setup {
  findings?: DependencyFindingsView;
  unread?: ServerNotification[];
  signedIn?: boolean;
  projects?: { id: string; name: string; folderPath: string }[];
  placements?: Map<string, { scopeId: number; canWrite: boolean }>;
  inventory?: Record<string, InventoryPackage[]>;
  hashes?: Record<string, string>;
  uploadAnswer?: (path: string) => Response | Error;
}

function setup(options: Setup = {}) {
  const calls: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }[] = [];
  const hub = fakeHub();
  let hashes: Record<string, string> = { ...(options.hashes ?? {}) };
  const inbox: {
    notification: ServerNotification;
    project: { id: string; name: string } | null;
  }[] = [];
  const announced: DependencyAlertsSummary[] = [];
  let findings: DependencyFindingsView = options.findings ?? { enabled: true, total: 0, items: [] };

  const deps: DependencyAlertsDeps = {
    api: async <T>(
      method: string,
      path: string,
      body?: unknown,
      extra?: { headers?: Record<string, string> },
    ) => {
      calls.push({ method, path, body, ...(extra?.headers ? { headers: extra.headers } : {}) });
      if (path === '/dependency-findings') return findings as T;
      if (path.startsWith('/notifications?')) return { items: options.unread ?? [] } as T;
      if (path.includes('/package-inventories/')) {
        const answer = options.uploadAnswer?.(path);
        if (answer instanceof Error) throw answer;
        return { id: 7 } as T;
      }
      return {} as T;
    },
    signedIn: async () => options.signedIn ?? true,
    projects: async () =>
      options.projects ?? [{ id: 'p-shop', name: 'Shop', folderPath: 'C:/code/shop' }],
    placements: async () =>
      options.placements ?? new Map([['p-shop', { scopeId: 1, canWrite: true }]]),
    readInventory: async (folder) => options.inventory?.[folder] ?? [LODASH],
    hashes: {
      read: async () => hashes,
      write: async (next) => {
        hashes = next;
      },
    },
    hub: () => hub.hub,
    inbox: async (n, project) => {
      inbox.push({ notification: n, project });
    },
    changed: (summary) => announced.push(summary),
  };
  const alerts = createDependencyAlerts(deps);
  return {
    alerts,
    calls,
    hub,
    inbox,
    announced,
    hashes: () => hashes,
    setFindings: (next: DependencyFindingsView) => {
      findings = next;
    },
  };
}

describe('upload', () => {
  it('uploads each project into its scope, then skips it while nothing changed', async () => {
    const { alerts, calls } = setup();

    expect(await alerts.upload()).toEqual({ uploaded: 1, skipped: 0 });
    expect(await alerts.upload()).toEqual({ uploaded: 0, skipped: 1 });

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe('/sync-scopes/1/package-inventories/p-shop');
    expect(puts[0].body).toEqual({ projectName: 'Shop', packages: [LODASH] });
  });

  it('uploads again when a package changes or the project moves to another scope', async () => {
    const placements = new Map([['p-shop', { scopeId: 1, canWrite: true }]]);
    const inventory = { 'C:/code/shop': [LODASH] };
    const { alerts, calls } = setup({ placements, inventory });
    await alerts.upload();

    inventory['C:/code/shop'] = [{ ...LODASH, version: '4.17.21' }];
    await alerts.upload();
    placements.set('p-shop', { scopeId: 2, canWrite: true });
    await alerts.upload();

    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual([
      '/sync-scopes/1/package-inventories/p-shop',
      '/sync-scopes/1/package-inventories/p-shop',
      '/sync-scopes/2/package-inventories/p-shop',
    ]);
  });

  it('leaves out a project with no folder here, one in a team this account only views, and one with no packages', async () => {
    const { alerts, calls } = setup({
      projects: [
        { id: 'p-remote', name: 'Remote', folderPath: '' },
        { id: 'p-viewed', name: 'Viewed', folderPath: 'C:/code/viewed' },
        { id: 'p-empty', name: 'Empty', folderPath: 'C:/code/empty' },
      ],
      placements: new Map([
        ['p-remote', { scopeId: 1, canWrite: true }],
        ['p-viewed', { scopeId: 3, canWrite: false }],
        ['p-empty', { scopeId: 1, canWrite: true }],
      ]),
      inventory: { 'C:/code/empty': [] },
    });

    expect(await alerts.upload()).toEqual({ uploaded: 0, skipped: 3 });
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('does nothing while signed out or turned off', async () => {
    const signedOut = setup({ signedIn: false });
    expect(await signedOut.alerts.upload()).toEqual({ uploaded: 0, skipped: 0 });
    expect(signedOut.calls).toEqual([]);

    const off = setup({ findings: { enabled: false, total: 0, items: [] } });
    await off.alerts.refresh();
    expect(await off.alerts.upload()).toEqual({ uploaded: 0, skipped: 0 });
    expect(off.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('tries a project again next time when its upload failed', async () => {
    let fail = true;
    const { alerts, hashes } = setup({
      uploadAnswer: () => (fail ? new Error('offline') : new Response()),
    });

    expect(await alerts.upload()).toEqual({ uploaded: 0, skipped: 1 });
    expect(hashes()).toEqual({});
    fail = false;
    expect(await alerts.upload()).toEqual({ uploaded: 1, skipped: 0 });
  });
});

describe('summary', () => {
  it('keys the findings by the local project and counts what is not muted', async () => {
    const { alerts, announced } = setup({
      findings: {
        enabled: true,
        total: 5,
        items: [findingsFor('p-shop', 3), findingsFor('p-blog', 0), findingsFor('p-old', 2, true)],
      },
    });

    const summary = await alerts.refresh();

    expect(summary.signedIn).toBe(true);
    expect(summary.projectsWithAlerts).toBe(1);
    expect(summary.total).toBe(3);
    expect(Object.keys(summary.byProject).sort()).toEqual(['p-blog', 'p-old', 'p-shop']);
    expect(announced.at(-1)).toEqual(summary);
  });

  it('is empty and signed out without an account', async () => {
    const { alerts } = setup({ signedIn: false });

    expect(await alerts.refresh()).toMatchObject({
      signedIn: false,
      total: 0,
      projectsWithAlerts: 0,
    });
  });
});

describe('live', () => {
  it('connects on start, catches up on unread messages and reads the findings', async () => {
    // The server lists them newest first.
    const { alerts, hub, inbox, calls } = setup({
      unread: [notification(2, null), notification(1)],
    });

    await alerts.start();

    expect(hub.hub.started).toBe(1);
    expect(inbox.map((i) => [i.notification.id, i.project?.name ?? null])).toEqual([
      [1, 'Shop'],
      [2, null],
    ]);
    expect(calls.some((c) => c.path === '/dependency-findings')).toBe(true);
    await alerts.stop();
    expect(hub.hub.stopped).toBe(1);
  });

  it('puts a pushed message in the inbox and reads the findings again when they change', async () => {
    const { alerts, hub, inbox, announced, setFindings } = setup();
    await alerts.start();
    const before = announced.length;

    hub.push(notification(5));
    setFindings({ enabled: true, total: 1, items: [findingsFor('p-shop', 1)] });
    hub.summaryChanged();
    await vi.waitFor(() => expect(announced.length).toBeGreaterThan(before));

    expect(inbox.at(-1)?.notification.id).toBe(5);
    expect(announced.at(-1)?.total).toBe(1);
  });

  it('catches up again after the connection comes back', async () => {
    const { alerts, hub, calls } = setup();
    await alerts.start();
    const reads = calls.filter((c) => c.path.startsWith('/notifications?')).length;

    hub.reconnect();

    await vi.waitFor(() =>
      expect(calls.filter((c) => c.path.startsWith('/notifications?')).length).toBe(reads + 1),
    );
  });

  it('does not connect while signed out', async () => {
    const { alerts, hub } = setup({ signedIn: false });

    await alerts.start();

    expect(hub.hub.started).toBe(0);
  });
});

describe('settings', () => {
  it('reads and changes the account settings, and mutes by project', async () => {
    const { alerts, calls } = setup({
      findings: { enabled: true, total: 1, items: [findingsFor('p-shop', 1)] },
    });
    await alerts.refresh();

    await alerts.updateSettings({ minor: true });
    await alerts.mute('p-shop', true);
    await alerts.mute('p-shop', false);

    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/accounts/me/dependency-alert-settings',
      body: { minor: true },
      headers: { 'if-match': '*' },
    });
    expect(
      calls.filter((c) => c.path === '/accounts/me/muted-projects/7').map((c) => c.method),
    ).toEqual(['PUT', 'DELETE']);
  });

  it('turning alerts back on uploads every project again', async () => {
    const { alerts, calls } = setup({ hashes: { '1:p-shop': 'stale' } });

    await alerts.updateSettings({ enabled: true });

    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
  });
});
