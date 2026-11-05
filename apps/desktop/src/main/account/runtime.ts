import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  changedFields,
  type EncryptionPolicy,
  SYNC_COLLECTIONS,
  sealingFor,
  splitFields,
  syncCollection,
} from '@runova/core';
import { app, safeStorage, shell } from 'electron';
import type { AccountStatus } from '../../shared/accountTypes';
import { IPC } from '../../shared/ipcChannels';
import type {
  ShareableGroup,
  SyncConflictView,
  SyncOverview,
  SyncScopeView,
  TeamView,
} from '../../shared/syncTypes';
import { broadcastToWindows } from '../ipc/send';
import { receiveLoopbackCode } from '../oauth/loopback';
import { createSyncEngine, type SyncEngine } from '../sync/engine';
import { createRemoteSyncApi, type RemoteSyncApi } from '../sync/remote';
import { openSyncDb, type SyncDb } from '../sync/syncDb';
import { withTeamMap } from '../sync/teamMap';
import type { SyncAdapter, SyncScopeInfo, SyncStatus } from '../sync/types';
import { type AccountClient, accountApiBaseUrl, createAccountClient, siteUrlFor } from './client';
import { createKeyService, type KeyService } from './keys';
import { type AccountState, type AccountStateFile, createAccountState } from './state';

/**
 * Binds the account (E48) to the real app: account.json and sync-state.db under userData/data,
 * the OS keychain, the browser, the windows, and the stores through the sync adapters. Nothing
 * here starts until the person signs in, and an e2e run reaches a server only when a test points
 * RUNOVA_ACCOUNT_API_URL at a fake one.
 */

const SYNC_EVERY_MS = 30_000;
const TRIGGER_DELAY_MS = 1_500;
const MASK = '••••••••';
const ALLOWED_PAGES = /^\/account(?:\/[a-z0-9-]+)*(?:\?[a-z0-9=&-]*)?$/;

function dataFile(name: string): string {
  return join(app.getPath('userData'), 'data', name);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await rename(temp, file);
}

function platform(): 'windows' | 'macos' | 'linux' {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

interface SyncSettingsFile {
  disabled: string[];
}

export interface AccountRuntimeOptions {
  /** The stores, as the sync engine sees them (sync/adapters). */
  adapters: () => SyncAdapter[];
  /** Announces a change from another computer so the screens refresh. */
  dataChanged?: (area: string) => void;
  /** Runs before each sync, such as reading whether the Servers passkey is locked. */
  beforeSync?: () => Promise<void>;
}

export function createAccountRuntime(options: AccountRuntimeOptions) {
  const state: AccountState = createAccountState({
    read: () => readJson(dataFile('account.json')),
    write: (value: AccountStateFile) => writeJson(dataFile('account.json'), value),
    canSeal: () => safeStorage.isEncryptionAvailable(),
    seal: (plain) => safeStorage.encryptString(plain).toString('base64'),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  });

  let signingIn: AbortController | null = null;
  let needsSignIn = false;

  const client: AccountClient = createAccountClient({
    fetch: (input, init) => globalThis.fetch(input, init),
    baseUrl: accountApiBaseUrl({ isPackaged: app.isPackaged, env: process.env }),
    userAgent: `Runova/${app.getVersion()} (${process.platform})`,
    state,
    device: {
      name: hostname() || 'This computer',
      platform: platform(),
      appVersion: app.getVersion(),
    },
    receiveCode: (request) =>
      receiveLoopbackCode(
        {
          openExternal: (url) => shell.openExternal(url),
          ...(signingIn ? { signal: signingIn.signal } : {}),
        },
        request,
      ),
    onNeedsSignIn: () => {
      needsSignIn = true;
      stopTimer();
      void announceAccount();
    },
  });

  const remote: RemoteSyncApi = createRemoteSyncApi(client);
  const keys: KeyService = createKeyService({ api: remote, state });

  let db: SyncDb | null = null;
  let engine: SyncEngine | null = null;
  let adapters: SyncAdapter[] = [];
  let scopes: SyncScopeInfo[] = [];
  let disabled = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let pending: NodeJS.Timeout | null = null;

  async function loadSyncSettings(): Promise<void> {
    const file = (await readJson(dataFile('sync-settings.json'))) as SyncSettingsFile | null;
    disabled = new Set(
      Array.isArray(file?.disabled) ? file.disabled.filter((c) => typeof c === 'string') : [],
    );
  }

  function getEngine(): SyncEngine {
    if (engine) return engine;
    const opened = openSyncDb(dataFile('sync-state.db'));
    db = opened;
    // Teams live beside the stores, which drop fields of ours when they save a record.
    adapters = options.adapters().map((adapter) => withTeamMap(adapter, opened));
    const remoteWithScopes = {
      ...remote,
      scopes: async () => {
        scopes = await remote.scopes();
        for (const scope of scopes) await keys.forgetIfStale(scope.id, scope.keyVersion);
        return scopes;
      },
    };
    engine = createSyncEngine({
      api: remoteWithScopes,
      db: opened,
      adapters,
      key: (scopeId) => keys.key(scopeId),
      enabled: (collection) => !disabled.has(collection),
      onApplied: (area) => options.dataChanged?.(area),
      onStatus: () => {
        void announceSync();
      },
    });
    return engine;
  }

  async function status(): Promise<AccountStatus> {
    const snapshot = await state.snapshot();
    if (signingIn) return { state: 'signing-in', deviceId: snapshot.deviceId };
    if (!snapshot.account || snapshot.sessionId === null) {
      return { state: 'signed-out', deviceId: snapshot.deviceId };
    }
    return {
      state: 'signed-in',
      deviceId: snapshot.deviceId,
      sessionId: snapshot.sessionId,
      account: snapshot.account,
      rememberedOnDisk: snapshot.rememberedOnDisk,
      needsSignIn: needsSignIn || client.needsSignIn(),
    };
  }

  async function announceAccount(): Promise<void> {
    broadcastToWindows(IPC.account.onChanged, await status());
  }

  async function announceSync(): Promise<void> {
    broadcastToWindows(IPC.sync.onChanged, await overview());
  }

  function startTimer(): void {
    stopTimer();
    timer = setInterval(() => trigger(0), SYNC_EVERY_MS);
    timer.unref?.();
  }

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Syncs soon: right away for a person's action, after a short pause for a store change. */
  function trigger(delay = TRIGGER_DELAY_MS): void {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void (async () => {
        if ((await status()).state !== 'signed-in' || needsSignIn) return;
        await options.beforeSync?.().catch(() => undefined);
        await getEngine()
          .sync()
          .catch(() => undefined);
      })();
    }, delay);
    pending.unref?.();
  }

  function scopeView(scope: SyncScopeInfo, unlocked: boolean): SyncScopeView {
    return {
      id: scope.id,
      kind: scope.kind,
      teamId: scope.teamId,
      name: scope.name,
      canWrite: scope.canWrite,
      canManage: scope.canManage,
      hasKey: scope.keyVersion !== null,
      unlockedHere: unlocked,
      policy: scope.policy,
    };
  }

  async function overview(): Promise<SyncOverview> {
    const signedIn = (await status()).state === 'signed-in';
    const current: SyncStatus = engine?.status() ?? {
      phase: signedIn ? 'idle' : 'signed-out',
      lastSyncedAt: null,
      error: null,
      conflicts: 0,
      needsKey: [],
    };
    const views: SyncScopeView[] = [];
    for (const scope of signedIn ? scopes : []) {
      const held = await keys.key(scope.id);
      views.push(scopeView(scope, !!held && held.version === scope.keyVersion));
    }
    return {
      ...current,
      phase: signedIn ? current.phase : 'signed-out',
      scopes: views,
      collections: SYNC_COLLECTIONS.map((c) => ({
        id: c.id,
        label: c.label,
        category: c.category,
        enabled: !disabled.has(c.id),
        needsKey: !!c.allSecret,
        shareable: c.shareable,
      })),
    };
  }

  function mask(
    adapter: SyncAdapter,
    value: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!value) return null;
    const split = splitFields(value, adapter.collection.fields);
    if (adapter.collection.allSecret) {
      return Object.fromEntries(
        Object.keys(split.shared).map((key) => [
          key,
          key === 'title' || key === 'name' ? split.shared[key] : MASK,
        ]),
      );
    }
    const masked = { ...split.shared };
    for (const path of Object.keys(split.secret)) masked[path] = MASK;
    return masked;
  }

  async function conflicts(): Promise<SyncConflictView[]> {
    const current = getEngine();
    const views: SyncConflictView[] = [];
    for (const conflict of current.conflicts()) {
      const adapter = adapters.find((a) => a.collection.id === conflict.collection);
      if (!adapter) continue;
      const local =
        (await adapter.list()).find((item) => item.id === conflict.itemId)?.value ?? null;
      const theirs = await current.theirs(conflict).catch(() => null);
      const mine = mask(adapter, local);
      const other = mask(adapter, theirs);
      const title = String(
        (local ?? theirs)?.name ??
          (local ?? theirs)?.title ??
          (local ?? theirs)?.host ??
          conflict.itemId,
      );
      views.push({
        scopeId: conflict.scopeId,
        scopeName: scopes.find((s) => s.id === conflict.scopeId)?.name ?? 'Personal',
        collection: conflict.collection,
        collectionLabel: adapter.collection.label,
        itemId: conflict.itemId,
        title,
        mine,
        theirs: other,
        changedFields: changedFields(mine ?? {}, other ?? {}),
        canKeepBoth: !!adapter.duplicate && !!mine && !!other,
        detectedAt: conflict.detectedAt,
      });
    }
    return views;
  }

  return {
    status,
    overview,
    conflicts,
    trigger,

    async start(): Promise<void> {
      await loadSyncSettings();
      if ((await status()).state === 'signed-in') {
        startTimer();
        trigger(0);
      }
    },

    stop(): void {
      stopTimer();
      if (pending) clearTimeout(pending);
      signingIn?.abort();
    },

    async signIn(): Promise<AccountStatus> {
      signingIn?.abort();
      signingIn = new AbortController();
      await announceAccount();
      try {
        await client.signIn({ signal: signingIn.signal });
        needsSignIn = false;
      } finally {
        signingIn = null;
        await announceAccount();
      }
      startTimer();
      trigger(0);
      return status();
    },

    cancelSignIn(): void {
      signingIn?.abort();
    },

    async signOut(): Promise<void> {
      stopTimer();
      await client.signOut();
      getEngine().reset();
      scopes = [];
      needsSignIn = false;
      await announceAccount();
      await announceSync();
    },

    profile: () => client.me(),
    sessions: () => client.sessions(),
    endSession: (id: number) => client.endSession(id),
    endOtherSessions: (stepUp: { password?: string; code?: string }) =>
      client.endOtherSessions(stepUp),
    activities: (page: number) => client.activities(page),

    async openWebsite(path: string): Promise<void> {
      if (!ALLOWED_PAGES.test(path)) throw new Error('That is not a page of the account panel.');
      await shell.openExternal(
        `${siteUrlFor(accountApiBaseUrl({ isPackaged: app.isPackaged, env: process.env }))}${path}`,
      );
    },

    async syncNow(): Promise<SyncOverview> {
      await options.beforeSync?.();
      await getEngine().sync();
      return overview();
    },

    async setCollectionEnabled(collection: string, enabled: boolean): Promise<void> {
      syncCollection(collection);
      if (enabled) disabled.delete(collection);
      else disabled.add(collection);
      await writeJson(dataFile('sync-settings.json'), {
        disabled: [...disabled],
      } satisfies SyncSettingsFile);
      trigger(0);
      await announceSync();
    },

    async setPolicy(scopeId: number, policy: EncryptionPolicy): Promise<void> {
      await remote.setPolicy(scopeId, policy);
      trigger(0);
    },

    usage: (scopeId: number) => remote.usage(scopeId),

    async setKey(scopeId: number, passphrase: string): Promise<{ recoveryKey: string }> {
      const result = await keys.setKey(scopeId, passphrase);
      trigger(0);
      return result;
    },

    async unlock(
      scopeId: number,
      secret: { passphrase?: string; recoveryKey?: string },
    ): Promise<void> {
      await keys.unlock(scopeId, secret);
      trigger(0);
      await announceSync();
    },

    changePassphrase: (scopeId: number, passphrase: string) =>
      keys.changePassphrase(scopeId, passphrase),

    async rotateKey(scopeId: number, passphrase: string): Promise<{ recoveryKey: string }> {
      const result = await keys.rotate(scopeId, passphrase);
      // Everything sealed under the old key is sent again under the new one.
      getEngine();
      db?.markScopeChanged(scopeId);
      trigger(0);
      return result;
    },

    async resetKey(scopeId: number, stepUp: { password?: string; code?: string }): Promise<void> {
      await keys.reset(scopeId, stepUp);
      trigger(0);
    },

    async wipeCloud(scopeId: number, stepUp: { password?: string; code?: string }): Promise<void> {
      await remote.wipe(scopeId, stepUp);
      trigger(0);
    },

    async resolve(
      target: { scopeId: number; collection: string; itemId: string },
      choice: 'mine' | 'theirs' | 'both',
    ): Promise<void> {
      await getEngine().resolve(target, choice);
    },

    /** Every shareable item, by collection, with the team it is in now. */
    async shareable(): Promise<ShareableGroup[]> {
      getEngine();
      const groups: ShareableGroup[] = [];
      for (const adapter of adapters.filter(
        (a) => a.collection.shareable && (a.ready?.() ?? true),
      )) {
        const items = (await adapter.list().catch(() => [])).filter((item) => !item.localOnly);
        groups.push({
          collection: adapter.collection.id,
          label: adapter.collection.label,
          items: items.map((item) => ({
            id: item.id,
            title: String(
              item.value.name ?? item.value.title ?? item.value.label ?? item.value.host ?? item.id,
            ),
            teamId: item.teamId,
          })),
        });
      }
      return groups;
    },

    /** Moves an item into a team's scope, or back to the person's own. */
    async share(target: {
      collection: string;
      itemId: string;
      teamId: number | null;
    }): Promise<void> {
      getEngine();
      const adapter = adapters.find((a) => a.collection.id === target.collection);
      if (!adapter?.collection.shareable) throw new Error('That can not be shared with a team.');
      if (target.teamId !== null) {
        const scope = scopes.find((s) => s.teamId === target.teamId);
        if (!scope?.canWrite) throw new Error('You can not add items to that team.');
        const sealing = sealingFor(adapter.collection, scope.policy, !!(await keys.key(scope.id)));
        if (sealing.mode === 'needs-key')
          throw new Error('Unlock the team key on this computer first.');
      }
      const item = (await adapter.list()).find((each) => each.id === target.itemId);
      if (!item) throw new Error('That item is not on this computer.');
      await adapter.apply({ ...item, teamId: target.teamId });
      options.dataChanged?.(adapter.area);
      trigger(0);
    },

    teams: {
      list: async () => (await client.request<{ items: TeamView[] }>('GET', '/teams')).items,
      create: async (name: string) => {
        const team = await client.request<TeamView>('POST', '/teams', { name });
        trigger(0);
        return team;
      },
      rename: (teamId: number, name: string) =>
        client.request<TeamView>('PATCH', `/teams/${teamId}`, { name }),
      remove: async (teamId: number, stepUp: { password?: string; code?: string }) => {
        await client.request<void>('DELETE', `/teams/${teamId}`, {
          password: stepUp.password ?? null,
          code: stepUp.code ?? null,
        });
        trigger(0);
      },
      members: async (teamId: number) =>
        (await client.request<{ items: unknown[] }>('GET', `/teams/${teamId}/members`)).items,
      changeRole: (
        teamId: number,
        userId: number,
        role: string,
        stepUp: { password?: string; code?: string },
      ) => client.request('PATCH', `/teams/${teamId}/members/${userId}`, { role, ...stepUp }),
      removeMember: async (
        teamId: number,
        userId: number,
        stepUp: { password?: string; code?: string },
      ) => {
        await client.request<void>('DELETE', `/teams/${teamId}/members/${userId}`, {
          password: stepUp.password ?? null,
          code: stepUp.code ?? null,
        });
        trigger(0);
      },
      invitations: async (teamId: number) =>
        (await client.request<{ items: unknown[] }>('GET', `/teams/${teamId}/invitations`)).items,
      invite: (teamId: number, email: string, role: string) =>
        client.request('POST', `/teams/${teamId}/invitations`, { email, role }),
      withdraw: (teamId: number, invitationId: number) =>
        client.request<void>('DELETE', `/teams/${teamId}/invitations/${invitationId}`),
      activities: (teamId: number, page: number) =>
        client.request('GET', `/teams/${teamId}/activities?page=${page}&pageSize=50`),
      myInvitations: async () =>
        (await client.request<{ items: unknown[] }>('GET', '/invitations')).items,
      accept: async (id: number) => {
        const team = await client.request<TeamView>('POST', `/invitations/${id}/acceptances`);
        trigger(0);
        return team;
      },
      decline: (id: number) => client.request<void>('DELETE', `/invitations/${id}`),
    },
  };
}

export type AccountRuntime = ReturnType<typeof createAccountRuntime>;

/** Syncs again when a window comes back to the front, which is when the person looks. */
export function syncOnFocus(runtime: Pick<AccountRuntime, 'trigger'>): void {
  app.on('browser-window-focus', () => runtime.trigger(0));
}
