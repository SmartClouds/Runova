import { createCollection, type PostmanCollection, type PostmanEvent } from '@runova/core';
import { describe, expect, it } from 'vitest';
import type { CollectionMeta } from '../../apiClient/collectionStore';
import { apiCollectionsAdapter, MAX_COLLECTION_BYTES } from './apiCollections';
import { TEAM_FIELD } from './arrayStore';

function meta(overrides: Partial<CollectionMeta> = {}): CollectionMeta {
  return {
    id: 'a1',
    name: 'Billing API',
    projectIds: ['p1'],
    scriptsTrusted: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function memoryCollections(
  initial: { meta: CollectionMeta; collection: PostmanCollection }[] = [],
) {
  let entries = structuredClone(initial);
  return {
    all: async () => structuredClone(entries),
    put: async (next: CollectionMeta, collection: PostmanCollection) => {
      const at = entries.findIndex((e) => e.meta.id === next.id);
      const entry = structuredClone({ meta: next, collection });
      if (at === -1) entries.push(entry);
      else entries[at] = entry;
    },
    remove: async (id: string) => {
      entries = entries.filter((e) => e.meta.id !== id);
    },
    get: () => entries,
  };
}

function script(line: string): PostmanEvent {
  return { listen: 'prerequest', script: { type: 'text/javascript', exec: [line] } };
}

/** The collection with one request that runs these test lines. */
function withScripts(collection: PostmanCollection, lines: string[]): PostmanCollection {
  collection.item.push({
    id: 'r1',
    name: 'Charge',
    request: { method: 'POST', url: 'https://billing.invalid' },
    event: lines.map((line) => ({ ...script(line), listen: 'test' })),
  } as never);
  return collection;
}

describe('apiCollectionsAdapter', () => {
  it('lists each collection as one item, its metadata and its Postman content together', async () => {
    const collection = createCollection('Billing API');
    const store = memoryCollections([{ meta: meta({ [TEAM_FIELD]: 3 } as never), collection }]);

    const [item] = await apiCollectionsAdapter(store).list();

    expect(item).toEqual({
      id: 'a1',
      teamId: 3,
      value: { ...meta(), collection },
    });
  });

  it('leaves out a collection too big for one sync record', async () => {
    const big = createCollection('Big');
    big.item = [
      {
        id: 'r1',
        name: 'Upload',
        request: {
          method: 'POST',
          url: 'https://x',
          body: { mode: 'raw', raw: 'x'.repeat(MAX_COLLECTION_BYTES) },
        },
      } as never,
    ];
    const store = memoryCollections([
      { meta: meta(), collection: createCollection('Small') },
      { meta: meta({ id: 'big' }), collection: big },
    ]);

    const items = await apiCollectionsAdapter(store).list();

    expect(items.filter((item) => !item.localOnly).map((item) => item.id)).toEqual(['a1']);
  });

  it('adds a collection from another computer with its scripts not yet trusted here', async () => {
    const store = memoryCollections();
    const { scriptsTrusted: _trusted, ...shared } = meta();
    const collection = createCollection('Billing API');

    await apiCollectionsAdapter(store).apply({
      id: 'a1',
      teamId: 5,
      value: { ...shared, collection },
    });

    expect(store.get()).toEqual([
      { meta: { ...meta(), scriptsTrusted: false, [TEAM_FIELD]: 5 }, collection },
    ]);
  });

  it('keeps the trust given on this computer on an update that leaves the scripts alone', async () => {
    const before = withScripts(createCollection('Billing API'), ['pm.test("ok")']);
    const store = memoryCollections([{ meta: meta(), collection: before }]);
    const after = withScripts(createCollection('Billing'), ['pm.test("ok")']);
    after.item.push({
      id: 'r2',
      name: 'New request',
      request: { method: 'GET', url: 'x' },
    } as never);

    await apiCollectionsAdapter(store).apply({
      id: 'a1',
      teamId: null,
      // The engine joins this computer's own fields back in, trust included.
      value: { ...meta({ name: 'Billing' }), collection: after },
    });

    expect(store.get()[0]?.meta).toMatchObject({ name: 'Billing', scriptsTrusted: true });
  });

  it('asks again before running scripts that changed somewhere else', async () => {
    const before = withScripts(createCollection('Billing API'), ['pm.test("ok")']);
    const changes: ((collection: PostmanCollection) => void)[] = [
      (c) => {
        c.event = [script('pm.sendRequest("http://elsewhere.invalid")')];
      },
      (c) => {
        (c.item[0] as { event?: unknown }).event = [script('pm.sendRequest("x")')];
      },
      (c) => {
        c.item.push({
          id: 'f1',
          name: 'Folder',
          item: [],
          event: [script('pm.sendRequest("y")')],
        } as never);
      },
    ];
    for (const change of changes) {
      const store = memoryCollections([{ meta: meta(), collection: before }]);
      const after = structuredClone(before);
      change(after);

      await apiCollectionsAdapter(store).apply({
        id: 'a1',
        teamId: 7,
        value: { ...meta(), collection: after },
      });

      expect(store.get()[0]?.meta.scriptsTrusted).toBe(false);
    }
  });

  it('removes a collection', async () => {
    const store = memoryCollections([
      { meta: meta(), collection: createCollection('Billing API') },
    ]);

    await apiCollectionsAdapter(store).remove('a1');

    expect(store.get()).toEqual([]);
  });
});
