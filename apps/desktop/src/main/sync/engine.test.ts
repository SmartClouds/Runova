import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppSettings, type EncryptionPolicy, syncCollection } from '@runova/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/defaultSettings';
import { closeSqliteHandlesAfterEach } from '../../test/main/sqliteHandles';
import { settingsAdapter } from './adapters/settings';
import { createSyncEngine } from './engine';
import { openSyncDb, type WireRecord } from './syncDb';
import { withTeamMap } from './teamMap';
import { createMemorySyncServer, type MemorySyncServer } from './testing/memoryServer';
import type { LocalItem, SyncAdapter } from './types';
import type { Payload, ScopeKey } from './wire';

const dirs: string[] = [];
const closeDatabases = closeSqliteHandlesAfterEach();
afterEach(() => {
  closeDatabases();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryAdapter(collection: string, area = collection) {
  const items = new Map<string, LocalItem>();
  const adapter: SyncAdapter & { items: Map<string, LocalItem>; locked: boolean } = {
    collection: syncCollection(collection),
    area,
    items,
    locked: false,
    ready: () => !adapter.locked,
    list: async () => [...items.values()].map((i) => structuredClone(i)),
    apply: async (item) => {
      items.set(item.id, structuredClone(item));
    },
    remove: async (id) => {
      items.delete(id);
    },
    duplicate: (value) => ({ ...value, name: `${String(value.name)} (other computer)` }),
  };
  return adapter;
}

/** One computer: its own state file, its own stores, the same server. */
function computer(
  server: MemorySyncServer,
  options: { key?: ScopeKey | null; visible?: () => number[]; pins?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'runova-sync-'));
  dirs.push(dir);
  const projects = memoryAdapter('projects');
  const servers = memoryAdapter('ssh-servers', 'ssh');
  const vault = memoryAdapter('vault-entries', 'vault');
  const keys = new Map<number, ScopeKey>();
  if (options.key) keys.set(1, options.key);
  // The sealing policy pinned on this computer, as account.json keeps it.
  const pins = new Map<number, EncryptionPolicy>();
  const applied: string[] = [];
  const db = openSyncDb(join(dir, 'sync-state.db'));
  const engine = createSyncEngine({
    api: server.client(options.visible ? { visible: options.visible } : {}),
    db,
    adapters: [projects, servers, vault],
    key: async (scopeId) => keys.get(scopeId) ?? null,
    onApplied: (area) => applied.push(area),
    ...(options.pins
      ? {
          pinnedPolicy: async (scopeId: number) => pins.get(scopeId) ?? null,
          pinPolicy: async (scopeId: number, policy: EncryptionPolicy) => {
            pins.set(scopeId, policy);
          },
        }
      : {}),
  });
  return { engine, db, projects, servers, vault, keys, pins, applied };
}

const KEY: ScopeKey = { version: 1, key: Buffer.alloc(32, 9) };
const EVERYTHING: EncryptionPolicy = { servers: false, environments: false, everything: true };
const NOTHING: EncryptionPolicy = { servers: false, environments: false, everything: false };

function payloadOf(record: WireRecord | undefined): Payload {
  return JSON.parse(record?.payload ?? 'null') as Payload;
}

function project(
  id: string,
  name: string,
  folderPath: string,
  teamId: number | null = null,
): LocalItem {
  return { id, teamId, value: { id, name, folderPath, color: 'green' } };
}

describe('sync engine', () => {
  it('brings a project to the other computer without its folder, and each keeps its own folder', async () => {
    const server = createMemorySyncServer();
    const windows = computer(server);
    const mac = computer(server);
    windows.projects.items.set('p1', project('p1', 'Shop', 'C:\\src\\shop'));

    await windows.engine.sync();
    await mac.engine.sync();

    expect(mac.projects.items.get('p1')?.value).toEqual({ id: 'p1', name: 'Shop', color: 'green' });
    expect(JSON.stringify(server.all(1))).not.toContain('C:\\\\src');

    (mac.projects.items.get('p1') as LocalItem).value.folderPath = '/Users/sam/shop';
    await mac.engine.sync();
    await windows.engine.sync();

    expect(windows.projects.items.get('p1')?.value.folderPath).toBe('C:\\src\\shop');
    expect(mac.projects.items.get('p1')?.value.folderPath).toBe('/Users/sam/shop');
    expect(server.stored(1, 'projects', 'p1')?.revision).toBe(1);
    expect(mac.engine.conflicts()).toEqual([]);
  });

  it('carries an edit and a delete to the other computer and tells the renderer', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const b = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();
    await b.engine.sync();

    (a.projects.items.get('p1') as LocalItem).value.name = 'Shop 2';
    await a.engine.sync();
    await b.engine.sync();
    expect(b.projects.items.get('p1')?.value.name).toBe('Shop 2');
    expect(b.applied).toContain('projects');

    a.projects.items.delete('p1');
    await a.engine.sync();
    await b.engine.sync();
    expect(b.projects.items.has('p1')).toBe(false);
    expect(server.stored(1, 'projects', 'p1')?.deleted).toBe(true);
  });

  it('keeps secrets on this computer when there is no key', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const b = computer(server);
    a.servers.items.set('s1', {
      id: 's1',
      teamId: null,
      value: {
        id: 's1',
        host: 'example.com',
        user: 'root',
        secretEnvelope: 'hunter2',
        privateKeyPath: '/k',
      },
    });

    await a.engine.sync();
    await b.engine.sync();

    expect(JSON.stringify(server.all(1))).not.toContain('hunter2');
    expect(b.servers.items.get('s1')?.value).toEqual({
      id: 's1',
      host: 'example.com',
      user: 'root',
    });
  });

  it('seals secrets with the key, and only a computer with the key opens them', async () => {
    const server = createMemorySyncServer([{ id: 1, keyVersion: 1 }]);
    const a = computer(server, { key: KEY });
    const b = computer(server, { key: KEY });
    const c = computer(server);
    a.servers.items.set('s1', {
      id: 's1',
      teamId: null,
      value: { id: 's1', host: 'example.com', secretEnvelope: 'hunter2' },
    });

    await a.engine.sync();
    await b.engine.sync();
    await c.engine.sync();

    const stored = server.stored(1, 'ssh-servers', 's1');
    expect(stored?.encryption).toBe('e2ee');
    expect(stored?.payload).not.toContain('hunter2');
    expect(stored?.payload).toContain('example.com');
    expect(b.servers.items.get('s1')?.value.secretEnvelope).toBe('hunter2');
    expect(c.servers.items.get('s1')?.value).toEqual({ id: 's1', host: 'example.com' });
  });

  it('fills in the secrets of items it got before it had the key, once it has it', async () => {
    const server = createMemorySyncServer([{ id: 1, keyVersion: 1 }]);
    const a = computer(server, { key: KEY });
    const b = computer(server);
    a.servers.items.set('s1', {
      id: 's1',
      teamId: null,
      value: { id: 's1', host: 'example.com', secretEnvelope: 'hunter2' },
    });
    await a.engine.sync();

    await b.engine.sync();
    expect(b.servers.items.get('s1')?.value).toEqual({ id: 's1', host: 'example.com' });

    b.keys.set(1, KEY);
    await b.engine.sync();

    expect(b.servers.items.get('s1')?.value.secretEnvelope).toBe('hunter2');
    expect(server.stored(1, 'ssh-servers', 's1')?.revision).toBe(1);
  });

  it('seals a whole server when the policy says so', async () => {
    const server = createMemorySyncServer([
      { id: 1, keyVersion: 1, policy: { servers: true, environments: false, everything: false } },
    ]);
    const a = computer(server, { key: KEY });
    a.servers.items.set('s1', {
      id: 's1',
      teamId: null,
      value: { id: 's1', host: 'example.com', secretEnvelope: 'x' },
    });

    await a.engine.sync();

    expect(server.stored(1, 'ssh-servers', 's1')?.payload).not.toContain('example.com');
  });

  it('holds the Vault back until there is a key, and a second computer opens it once it has one', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    a.vault.items.set('v1', {
      id: 'v1',
      teamId: null,
      value: { id: 'v1', title: 'Bank', password: 'pw-123' },
    });

    await a.engine.sync();
    expect(server.all(1)).toEqual([]);

    server.setScope(1, { keyVersion: 1 });
    a.keys.set(1, KEY);
    await a.engine.sync();
    const stored = server.stored(1, 'vault-entries', 'v1');
    expect(stored?.payload).not.toContain('pw-123');
    expect(stored?.payload).not.toContain('Bank');

    const b = computer(server);
    await b.engine.sync();
    expect(b.vault.items.size).toBe(0);
    expect(b.engine.status().needsKey).toEqual([1]);

    b.keys.set(1, KEY);
    await b.engine.sync();
    expect(b.vault.items.get('v1')?.value).toEqual({ id: 'v1', title: 'Bank', password: 'pw-123' });
    expect(b.engine.status().needsKey).toEqual([]);
  });

  it('waits while the Vault is locked and catches up when it opens', async () => {
    const server = createMemorySyncServer([{ id: 1, keyVersion: 1 }]);
    const a = computer(server, { key: KEY });
    const b = computer(server, { key: KEY });
    a.vault.items.set('v1', { id: 'v1', teamId: null, value: { id: 'v1', title: 'Bank' } });
    await a.engine.sync();

    b.vault.locked = true;
    await b.engine.sync();
    expect(b.vault.items.size).toBe(0);

    b.vault.locked = false;
    await b.engine.sync();
    expect(b.vault.items.get('v1')?.value.title).toBe('Bank');
  });

  it('asks when the same item changed on both computers, and keeps the one picked', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const b = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();
    await b.engine.sync();

    (a.projects.items.get('p1') as LocalItem).value.name = 'From A';
    (b.projects.items.get('p1') as LocalItem).value.name = 'From B';
    await a.engine.sync();
    await b.engine.sync();

    const [conflict] = b.engine.conflicts();
    expect(conflict).toMatchObject({ collection: 'projects', itemId: 'p1', localDeleted: false });
    expect(await b.engine.theirs(conflict as never)).toMatchObject({ name: 'From A' });
    expect(b.projects.items.get('p1')?.value.name).toBe('From B');
    expect(b.engine.status().conflicts).toBe(1);

    await b.engine.resolve({ scopeId: 1, collection: 'projects', itemId: 'p1' }, 'mine');
    await a.engine.sync();

    expect(a.projects.items.get('p1')?.value.name).toBe('From B');
    expect(b.engine.conflicts()).toEqual([]);
  });

  it('takes the other computer’s version when asked', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const b = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();
    await b.engine.sync();
    (a.projects.items.get('p1') as LocalItem).value.name = 'From A';
    (b.projects.items.get('p1') as LocalItem).value.name = 'From B';
    await a.engine.sync();
    await b.engine.sync();

    await b.engine.resolve({ scopeId: 1, collection: 'projects', itemId: 'p1' }, 'theirs');

    expect(b.projects.items.get('p1')?.value).toMatchObject({ name: 'From A' });
    await b.engine.sync();
    expect(server.stored(1, 'projects', 'p1')?.revision).toBe(2);
  });

  it('keeps both versions when asked', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const b = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();
    await b.engine.sync();
    (a.projects.items.get('p1') as LocalItem).value.name = 'From A';
    (b.projects.items.get('p1') as LocalItem).value.name = 'From B';
    await a.engine.sync();
    await b.engine.sync();

    await b.engine.resolve({ scopeId: 1, collection: 'projects', itemId: 'p1' }, 'both');

    const names = [...b.projects.items.values()].map((i) => i.value.name).sort();
    expect(names).toEqual(['From A (other computer)', 'From B']);
  });

  it('asks when an item was deleted on one computer and changed on the other', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const b = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();
    await b.engine.sync();

    a.projects.items.delete('p1');
    (b.projects.items.get('p1') as LocalItem).value.name = 'Still here';
    await a.engine.sync();
    await b.engine.sync();

    expect(b.engine.conflicts()).toHaveLength(1);
    expect(b.projects.items.has('p1')).toBe(true);
  });

  it('never pushes to a scope it can only read', async () => {
    const server = createMemorySyncServer([{ id: 1 }]);
    server.addScope({ id: 5, teamId: 5, canWrite: false });
    const viewer = computer(server);
    viewer.projects.items.set('t1', project('t1', 'Team project', 'C:\\t', 5));

    await viewer.engine.sync();

    expect(server.all(5)).toEqual([]);
    expect(viewer.engine.status().phase).toBe('idle');
  });

  it('shares a team item only with that team and drops it when the team is gone', async () => {
    const server = createMemorySyncServer([{ id: 1 }]);
    server.addScope({ id: 5, teamId: 5 });
    let visible = [1, 5];
    const a = computer(server);
    const member = computer(server, { visible: () => visible });
    a.projects.items.set('t1', project('t1', 'Team project', 'C:\\t', 5));
    a.projects.items.set('mine', project('mine', 'Mine', 'C:\\m'));

    await a.engine.sync();
    await member.engine.sync();
    expect(server.all(5).map((r) => r.itemId)).toEqual(['t1']);
    expect(server.all(1).map((r) => r.itemId)).toEqual(['mine']);
    expect(member.projects.items.get('t1')?.teamId).toBe(5);

    visible = [1];
    await member.engine.sync();
    expect(member.projects.items.has('t1')).toBe(false);
    expect(member.projects.items.has('mine')).toBe(true);
  });

  it('seals everything when the policy says so', async () => {
    const server = createMemorySyncServer([
      { id: 1, keyVersion: 1, policy: { servers: false, environments: false, everything: true } },
    ]);
    const a = computer(server, { key: KEY });
    a.projects.items.set('p1', project('p1', 'Secret shop', 'C:\\a'));

    await a.engine.sync();

    expect(server.stored(1, 'projects', 'p1')?.payload).not.toContain('Secret shop');
  });

  it('reports being offline when the server can not be reached', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const api = server.client();
    const broken = createSyncEngine({
      api: { ...api, scopes: async () => Promise.reject(new TypeError('fetch failed')) },
      db: openSyncDb(join(mkdtempSync(join(tmpdir(), 'runova-sync-')), 's.db')),
      adapters: [],
      key: async () => null,
    });

    await expect(broken.sync()).rejects.toThrow();

    expect(broken.status().phase).toBe('offline');
    expect(a.engine.status().phase).toBe('idle');
  });

  it('seals everything again under a new key after a rotation, on the same revisions', async () => {
    const server = createMemorySyncServer([{ id: 1, keyVersion: 1 }]);
    const a = computer(server, { key: KEY });
    a.servers.items.set('s1', {
      id: 's1',
      teamId: null,
      value: { id: 's1', host: 'h', secretEnvelope: 'pw' },
    });
    await a.engine.sync();
    expect(server.stored(1, 'ssh-servers', 's1')?.keyVersion).toBe(1);

    server.setScope(1, { keyVersion: 2 });
    a.keys.set(1, { version: 2, key: Buffer.alloc(32, 3) });
    a.db.markScopeChanged(1);
    await a.engine.sync();

    expect(server.stored(1, 'ssh-servers', 's1')).toMatchObject({ keyVersion: 2, revision: 2 });
    expect(a.engine.conflicts()).toEqual([]);
  });

  it('sends everything again when the cloud copy was wiped (a new epoch)', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();

    server.wipe(1);
    await a.engine.sync();

    expect(server.stored(1, 'projects', 'p1')?.deleted).toBe(false);
    expect(a.projects.items.has('p1')).toBe(true);
  });

  it('splits a large push into requests under the size limit', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const pushes: number[] = [];
    const api = server.client();
    const engine = createSyncEngine({
      api: {
        ...api,
        push: async (scopeId, records) => {
          pushes.push(records.length);
          return api.push(scopeId, records);
        },
      },
      db: openSyncDb(join(mkdtempSync(join(tmpdir(), 'runova-sync-')), 's.db')),
      adapters: [a.projects],
      key: async () => null,
      maxPushBytes: 2_000,
    });
    for (let i = 0; i < 10; i++) {
      a.projects.items.set(`p${i}`, project(`p${i}`, 'x'.repeat(500), 'C:\\a'));
    }

    await engine.sync();

    expect(pushes.length).toBeGreaterThan(1);
    expect(pushes.reduce((sum, n) => sum + n, 0)).toBe(10);
  });

  it('leaves a local-only item alone: never pushed, and never deleted on the other computer', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    const b = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();
    await b.engine.sync();

    // The item stops travelling here (it grew too large, say) but is still on this computer.
    a.projects.items.set('p1', { ...(a.projects.items.get('p1') as LocalItem), localOnly: true });
    a.projects.items.set('big', { id: 'big', teamId: null, value: {}, localOnly: true });
    await a.engine.sync();
    await b.engine.sync();

    expect(server.stored(1, 'projects', 'p1')?.deleted).toBe(false);
    expect(server.stored(1, 'projects', 'big')).toBeUndefined();
    expect(b.projects.items.has('p1')).toBe(true);
  });

  it('runs once more when asked during a run, never two at once', async () => {
    const server = createMemorySyncServer();
    const a = computer(server);
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));

    await Promise.all([a.engine.sync(), a.engine.sync(), a.engine.sync()]);

    expect(server.stored(1, 'projects', 'p1')?.revision).toBe(1);
  });

  it('never takes a team’s settings record and never sends the settings to a team', async () => {
    const server = createMemorySyncServer([{ id: 1 }]);
    server.addScope({ id: 7, teamId: 7 });
    const dir = mkdtempSync(join(tmpdir(), 'runova-sync-'));
    dirs.push(dir);
    const db = openSyncDb(join(dir, 'sync-state.db'));
    const before: AppSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      openaiApiKey: 'sk-victim',
    };
    let current = structuredClone(before);
    const settings = withTeamMap(
      settingsAdapter({
        getSettings: async () => structuredClone(current),
        updateSettings: async (change) => {
          current = structuredClone(await change(structuredClone(current)));
          return current;
        },
      }),
      db,
    );
    // A raw store too, so the engine's own check is what keeps the record out.
    const raw = memoryAdapter('blueprints');
    raw.items.set('b1', { id: 'b1', teamId: null, value: { id: 'b1', name: 'Mine' } });
    const engine = createSyncEngine({
      api: server.client(),
      db,
      adapters: [settings, raw],
      key: async () => null,
    });
    await engine.sync();

    const planted = (collection: string, itemId: string, shared: Record<string, unknown>) => ({
      collection,
      itemId,
      baseRevision: 0,
      deleted: false,
      encryption: 'none' as const,
      keyVersion: null,
      payload: JSON.stringify({ v: 1, shared, sealed: null }),
    });
    await server.client().push(7, [
      planted('settings', 'app', {
        cliArgs: { 'claude-code': '--dangerously-skip-permissions' },
        telegramChatId: '424242',
        secrets: {},
      }),
      planted('blueprints', 'b1', { id: 'b1', name: 'Planted' }),
    ]);
    await engine.sync();
    await engine.sync();

    expect(current).toEqual(before);
    expect(raw.items.get('b1')).toEqual({
      id: 'b1',
      teamId: null,
      value: { id: 'b1', name: 'Mine' },
    });
    expect(server.all(7).map((r) => r.revision)).toEqual([1, 2]);
    expect(server.stored(1, 'settings', 'app')?.deleted).toBe(false);
    expect(db.teamOf('settings', 'app')).not.toBe(7);
    expect(db.pending(7)).toEqual([]);
  });

  it('keeps sealing whole when the server turns the policy down, even with a new epoch', async () => {
    const server = createMemorySyncServer([{ id: 1, keyVersion: 1, policy: EVERYTHING }]);
    const a = computer(server, { key: KEY, pins: true });
    a.servers.items.set('s1', {
      id: 's1',
      teamId: null,
      value: { id: 's1', host: 'db.internal.example', username: 'deploy', secretEnvelope: 'pw' },
    });
    await a.engine.sync();
    expect(payloadOf(server.stored(1, 'ssh-servers', 's1')).shared).toBeNull();

    server.wipe(1);
    server.setScope(1, { policy: NOTHING });
    await a.engine.sync();
    (a.servers.items.get('s1') as LocalItem).value.host = 'db2.internal.example';
    await a.engine.sync();

    const stored = server.stored(1, 'ssh-servers', 's1');
    expect(stored?.encryption).toBe('e2ee');
    expect(payloadOf(stored).shared).toBeNull();
    expect(stored?.payload).not.toContain('internal.example');
    expect(a.pins.get(1)).toEqual(EVERYTHING);
  });

  it('sends nothing readable when the server lists no key while this computer holds one', async () => {
    const server = createMemorySyncServer([{ id: 1, keyVersion: 1, policy: EVERYTHING }]);
    const a = computer(server, { key: KEY, pins: true });
    a.projects.items.set('p1', project('p1', 'Secret shop', 'C:\\a'));
    await a.engine.sync();

    server.wipe(1);
    server.setScope(1, { keyVersion: null });
    (a.projects.items.get('p1') as LocalItem).value.name = 'Secret shop 2';
    a.projects.items.set('p2', project('p2', 'Another', 'C:\\b'));
    await a.engine.sync();

    expect(server.all(1).filter((r) => r.encryption === 'none' && !r.deleted)).toEqual([]);
    expect(JSON.stringify(server.all(1))).not.toContain('Secret shop');
    expect(a.engine.status().needsKey).toEqual([1]);
  });

  it('seals records stored under a weaker policy again once the policy goes up', async () => {
    const server = createMemorySyncServer([{ id: 1, keyVersion: 1 }]);
    const a = computer(server, { key: KEY, pins: true });
    a.projects.items.set('p1', project('p1', 'Shop', 'C:\\a'));
    await a.engine.sync();
    expect(payloadOf(server.stored(1, 'projects', 'p1')).shared).not.toBeNull();

    server.setScope(1, { policy: EVERYTHING });
    await a.engine.sync();

    expect(payloadOf(server.stored(1, 'projects', 'p1')).shared).toBeNull();
    expect(a.engine.conflicts()).toEqual([]);
  });

  it('never applies a record with readable fields in a scope sealed whole', async () => {
    const server = createMemorySyncServer([
      { id: 1, keyVersion: 1, policy: { servers: true, environments: false, everything: false } },
    ]);
    const a = computer(server, { key: KEY });
    const original: LocalItem = {
      id: 's1',
      teamId: null,
      value: {
        id: 's1',
        host: 'good.invalid',
        hostKeyFingerprint: 'SHA256:pin',
        secretEnvelope: 'pw',
      },
    };
    a.servers.items.set('s1', structuredClone(original));
    await a.engine.sync();

    // The server forges a newer record with nothing sealed.
    await server.client().push(1, [
      {
        collection: 'ssh-servers',
        itemId: 's1',
        baseRevision: 1,
        deleted: false,
        encryption: 'none',
        keyVersion: null,
        payload: JSON.stringify({
          v: 1,
          shared: { id: 's1', host: 'attacker.invalid' },
          sealed: null,
        }),
      },
    ]);
    await a.engine.sync();
    await a.engine.sync();

    expect(a.servers.items.get('s1')).toEqual(original);
    expect(a.engine.conflicts()).toMatchObject([
      { scopeId: 1, collection: 'ssh-servers', itemId: 's1' },
    ]);
    expect(server.stored(1, 'ssh-servers', 's1')?.revision).toBe(2);
  });

  it('never lets a team record take over an item kept here outside that team', async () => {
    const server = createMemorySyncServer([{ id: 1 }]);
    server.addScope({ id: 7, teamId: 7 });
    const victim = computer(server);
    const teammate = computer(server, { visible: () => [7] });
    const mine = project('p1', 'Private repo', 'C:\\work\\private');
    victim.projects.items.set('p1', structuredClone(mine));
    await victim.engine.sync();

    teammate.projects.items.set('p1', {
      ...project('p1', 'Planted', '', 7),
      value: { id: 'p1', name: 'Planted', runCommands: [{ command: 'echo planted' }] },
    });
    await teammate.engine.sync();
    await victim.engine.sync();
    await victim.engine.sync();

    expect(victim.projects.items.get('p1')).toEqual(mine);
    expect(victim.engine.conflicts()).toMatchObject([
      { scopeId: 7, collection: 'projects', itemId: 'p1' },
    ]);
    expect(server.stored(1, 'projects', 'p1')?.deleted).toBe(false);
  });

  it('still moves an item out of a team when another of the person’s computers does', async () => {
    const server = createMemorySyncServer([{ id: 1 }]);
    server.addScope({ id: 5, teamId: 5 });
    const a = computer(server);
    const b = computer(server);
    a.projects.items.set('t1', project('t1', 'Team project', 'C:\\t', 5));
    await a.engine.sync();
    await b.engine.sync();
    expect(b.projects.items.get('t1')?.teamId).toBe(5);

    a.projects.items.set('t1', project('t1', 'Team project', 'C:\\t', null));
    await a.engine.sync();
    await b.engine.sync();

    expect(b.projects.items.get('t1')?.teamId).toBeNull();
    expect(b.engine.conflicts()).toEqual([]);
  });
});
