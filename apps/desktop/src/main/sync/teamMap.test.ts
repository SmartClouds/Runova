import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCollection } from '@runova/core';
import { afterEach, describe, expect, it } from 'vitest';
import { closeSqliteHandlesAfterEach } from '../../test/main/sqliteHandles';
import { openSyncDb } from './syncDb';
import { withTeamMap } from './teamMap';
import type { LocalItem, SyncAdapter } from './types';

const dirs: string[] = [];
const close = closeSqliteHandlesAfterEach();
afterEach(() => {
  close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A store whose own save path forgets the team, as the real SSH and Vault saves do. */
function forgetfulStore() {
  const items = new Map<string, LocalItem>();
  const adapter: SyncAdapter = {
    collection: syncCollection('ssh-servers'),
    area: 'ssh',
    list: async () => [...items.values()].map((i) => ({ ...i, teamId: null })),
    apply: async (item) => {
      items.set(item.id, item);
    },
    remove: async (id) => {
      items.delete(id);
    },
  };
  return { adapter, items };
}

function db() {
  const dir = mkdtempSync(join(tmpdir(), 'runova-teams-'));
  dirs.push(dir);
  return openSyncDb(join(dir, 'sync-state.db'));
}

describe('withTeamMap', () => {
  it('remembers the team of an item even when the store forgets it', async () => {
    const store = forgetfulStore();
    const adapter = withTeamMap(store.adapter, db());

    await adapter.apply({ id: 's1', teamId: 5, value: { host: 'h' } });

    expect((await adapter.list())[0]?.teamId).toBe(5);
  });

  it('moves an item back to the person’s own', async () => {
    const store = forgetfulStore();
    const adapter = withTeamMap(store.adapter, db());
    await adapter.apply({ id: 's1', teamId: 5, value: {} });

    await adapter.apply({ id: 's1', teamId: null, value: {} });

    expect((await adapter.list())[0]?.teamId).toBeNull();
  });

  it('forgets the team when the item goes, and keeps teams apart by collection', async () => {
    const state = db();
    const store = forgetfulStore();
    const adapter = withTeamMap(store.adapter, state);
    await adapter.apply({ id: 's1', teamId: 5, value: {} });

    await adapter.remove('s1');

    expect(state.teamOf('ssh-servers', 's1')).toBeUndefined();
    state.setTeam('projects', 's1', 9);
    expect(state.teamOf('ssh-servers', 's1')).toBeUndefined();
  });
});
