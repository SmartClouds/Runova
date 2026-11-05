import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCollection } from '@runova/core';
import { afterEach, describe, expect, it } from 'vitest';
import { closeSqliteHandlesAfterEach } from '../../test/main/sqliteHandles';
import { createSyncEngine } from './engine';
import { openSyncDb } from './syncDb';
import { createMemorySyncServer, type MemorySyncServer } from './testing/memoryServer';
import type { LocalItem, SyncAdapter } from './types';
import type { ScopeKey } from './wire';

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
  options: { key?: ScopeKey | null; visible?: () => number[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'runova-sync-'));
  dirs.push(dir);
  const projects = memoryAdapter('projects');
  const servers = memoryAdapter('ssh-servers', 'ssh');
  const vault = memoryAdapter('vault-entries', 'vault');
  const keys = new Map<number, ScopeKey>();
  if (options.key) keys.set(1, options.key);
  const applied: string[] = [];
  const db = openSyncDb(join(dir, 'sync-state.db'));
  const engine = createSyncEngine({
    api: server.client(options.visible ? { visible: options.visible } : {}),
    db,
    adapters: [projects, servers, vault],
    key: async (scopeId) => keys.get(scopeId) ?? null,
    onApplied: (area) => applied.push(area),
  });
  return { engine, db, projects, servers, vault, keys, applied };
}

const KEY: ScopeKey = { version: 1, key: Buffer.alloc(32, 9) };

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
});
