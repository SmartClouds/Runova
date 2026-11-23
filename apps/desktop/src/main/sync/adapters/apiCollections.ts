import { canonicalJson, type PostmanCollection, syncCollection } from '@runova/core';
import type { CollectionMeta } from '../../apiClient/collectionStore';
import { fromAnotherComputer } from './copyName';
import { recordStoreAdapter } from './recordStore';

/** The parts of the API Client's `collectionStore` sync uses. */
export interface ApiCollectionsPort {
  all: () => Promise<{ meta: CollectionMeta; collection: PostmanCollection }[]>;
  put: (meta: CollectionMeta, collection: PostmanCollection) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** A collection as it syncs: its metadata with its Postman content beside it. */
type SyncedCollection = CollectionMeta & { collection: PostmanCollection };

/**
 * The server takes a record of up to 1 MB. A sealed record is base64, a third bigger than the
 * JSON it holds, so a collection over 700 KB could be refused once the scope seals everything.
 */
export const MAX_COLLECTION_BYTES = 700 * 1024;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8');
}

/** Every script in a collection (its own, its folders' and its requests'), in order. */
function scriptsOf(node: unknown, found: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return found;
  const { event, item } = node as { event?: unknown; item?: unknown };
  if (Array.isArray(event) && event.length) found.push(event);
  if (Array.isArray(item)) for (const child of item) scriptsOf(child, found);
  return found;
}

function sameScripts(a: PostmanCollection, b: PostmanCollection): boolean {
  return canonicalJson(scriptsOf(a)) === canonicalJson(scriptsOf(b));
}

/**
 * API Client collections (E48). Each collection is one item: its metadata and its Postman content
 * together. One too big for a record stays on this computer only. Whether its scripts may run is
 * decided on each computer, so a collection from somewhere else waits for the person to trust it
 * here too.
 */
export function apiCollectionsAdapter(store: ApiCollectionsPort) {
  return recordStoreAdapter<SyncedCollection>({
    collection: syncCollection('api-collections'),
    area: 'apiClient',
    list: async () => (await store.all()).map(({ meta, collection }) => ({ ...meta, collection })),
    put: ({ collection, ...meta }) => store.put(meta, collection),
    remove: (id) => store.remove(id),
    id: (item) => item.id,
    syncs: (item) => bytes(item) <= MAX_COLLECTION_BYTES,
    fromValue: (value, existing) => {
      const next = value as unknown as SyncedCollection;
      // Trust covers the scripts the person trusted here. New or changed scripts from somewhere
      // else wait until the person trusts the collection again.
      const trusted =
        existing?.scriptsTrusted === true && sameScripts(existing.collection, next.collection);
      return { ...next, scriptsTrusted: trusted };
    },
    duplicate: (value) => ({ ...value, name: fromAnotherComputer(value.name, 120) }),
  });
}
