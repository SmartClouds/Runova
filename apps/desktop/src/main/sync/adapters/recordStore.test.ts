import { syncCollection } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { memorySecrets, sealed } from '../testing/memorySecrets';
import { TEAM_FIELD } from './arrayStore';
import { recordStoreAdapter } from './recordStore';

interface Item {
  id: string;
  name: string;
  local?: boolean;
  passwordEnvelope?: unknown;
  [TEAM_FIELD]?: number;
}

function memoryRecords(initial: Item[] = []) {
  let items = structuredClone(initial);
  const writes: string[] = [];
  return {
    list: async () => structuredClone(items),
    put: async (item: Item) => {
      writes.push(`put:${item.id}`);
      const index = items.findIndex((one) => one.id === item.id);
      if (index === -1) items.push(structuredClone(item));
      else items[index] = structuredClone(item);
    },
    remove: async (id: string) => {
      writes.push(`remove:${id}`);
      items = items.filter((one) => one.id !== id);
    },
    get: () => items,
    writes,
  };
}

function adapter(store: ReturnType<typeof memoryRecords>, changed: string[][] = []) {
  return recordStoreAdapter<Item>({
    collection: syncCollection('database-connections'),
    area: 'database',
    list: store.list,
    put: store.put,
    remove: store.remove,
    id: (item) => item.id,
    secrets: memorySecrets(),
    syncs: (item) => !item.local,
    afterWrite: (ids) => changed.push(ids),
  });
}

describe('recordStoreAdapter', () => {
  it('lists the items that sync with their secrets opened, and the rest as local only', async () => {
    const store = memoryRecords([
      { id: 'a', name: 'Shop', passwordEnvelope: sealed('pw'), [TEAM_FIELD]: 4 },
      { id: 'b', name: 'Here only', local: true },
    ]);

    const items = await adapter(store).list();

    expect(items).toEqual([
      { id: 'a', teamId: 4, value: { id: 'a', name: 'Shop', passwordEnvelope: { $secret: 'pw' } } },
      // Listed so sync leaves it alone; missing, it would be deleted on the other computers.
      { id: 'b', teamId: null, value: {}, localOnly: true },
    ]);
  });

  it('puts one item, sealed again, with its team, and tells the store', async () => {
    const store = memoryRecords();
    const changed: string[][] = [];

    await adapter(store, changed).apply({
      id: 'a',
      teamId: 9,
      value: { id: 'a', name: 'Shop', passwordEnvelope: { $secret: 'pw' } },
    });

    expect(store.get()).toEqual([
      { id: 'a', name: 'Shop', passwordEnvelope: sealed('pw'), [TEAM_FIELD]: 9 },
    ]);
    expect(changed).toEqual([['a']]);
  });

  it('takes an item out of a team when it arrives as the person’s own', async () => {
    const store = memoryRecords([{ id: 'a', name: 'Shop', [TEAM_FIELD]: 4 }]);

    await adapter(store).apply({ id: 'a', teamId: null, value: { id: 'a', name: 'Shop' } });

    expect(store.get()[0]).not.toHaveProperty(TEAM_FIELD);
  });

  it('stores a "Keep both" copy under the id it is applied with', async () => {
    const store = memoryRecords([{ id: 'a', name: 'Mine' }]);

    await adapter(store).apply({ id: 'copy', teamId: null, value: { id: 'a', name: 'Theirs' } });

    expect(store.get().map((item) => item.id)).toEqual(['a', 'copy']);
  });

  it('removes an item that syncs and leaves alone one that never did', async () => {
    const store = memoryRecords([
      { id: 'a', name: 'Shop' },
      { id: 'b', name: 'Here only', local: true },
    ]);
    const changed: string[][] = [];
    const records = adapter(store, changed);

    await records.remove('a');
    await records.remove('b');
    await records.remove('missing');

    expect(store.get().map((item) => item.id)).toEqual(['b']);
    expect(store.writes).toEqual(['remove:a']);
    expect(changed).toEqual([['a']]);
  });
});
