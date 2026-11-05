import { type PostmanCollection, syncCollection } from '@runova/core';
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
    fromValue: (value, existing) => ({
      ...(value as unknown as SyncedCollection),
      scriptsTrusted: existing?.scriptsTrusted ?? false,
    }),
    duplicate: (value) => ({ ...value, name: fromAnotherComputer(value.name, 120) }),
  });
}
