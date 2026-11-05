import type { SyncCollection } from '@runova/core';
import type { LocalItem, SyncAdapter } from '../types';
import { type SecretPort, TEAM_FIELD } from './arrayStore';
import { openEnvelopes, sealSecrets } from './envelopes';

export interface RecordStoreOptions<T> {
  collection: SyncCollection;
  area: string;
  list: () => Promise<T[]>;
  /** Adds the item, or replaces the one with its id, in one turn of the store's own queue. */
  put: (item: T) => Promise<void>;
  remove: (id: string) => Promise<void>;
  id: (item: T) => string;
  secrets?: SecretPort;
  ready?: () => boolean;
  /** False for an item that stays on this computer: it is never listed, replaced or removed. */
  syncs?: (item: T) => boolean;
  /** The item as it syncs, before the field split. */
  toValue?: (item: T) => Record<string, unknown>;
  /** The item to store from what arrived, given what was here before (null for a new one). */
  fromValue?: (value: Record<string, unknown>, existing: T | null) => T;
  afterWrite?: (ids: string[]) => void;
  duplicate?: (value: Record<string, unknown>) => Record<string, unknown>;
}

function teamOf(item: unknown): number | null {
  const team = (item as Record<string, unknown>)[TEAM_FIELD];
  return typeof team === 'number' ? team : null;
}

/**
 * An adapter for a store that keeps its own write queue and changes one record at a time (the
 * database connections, monitors, error tracking, the API client and the Vault). Each write
 * goes through that queue, so a change made here at the same moment is never written over.
 * Secrets are opened for the sync and sealed again on the way in, as in arrayStore.ts.
 */
export function recordStoreAdapter<T>(options: RecordStoreOptions<T>): SyncAdapter {
  const toValue = options.toValue ?? ((item: T) => ({ ...(item as Record<string, unknown>) }));
  const fromValue = options.fromValue ?? ((value: Record<string, unknown>) => value as T);
  const syncs = options.syncs ?? (() => true);

  async function syncing(): Promise<{ item: T; travels: boolean }[]> {
    return (await options.list()).map((item) => ({ item, travels: syncs(item) }));
  }

  return {
    collection: options.collection,
    area: options.area,
    ...(options.ready ? { ready: options.ready } : {}),
    ...(options.duplicate ? { duplicate: options.duplicate } : {}),

    async list(): Promise<LocalItem[]> {
      const out: LocalItem[] = [];
      for (const { item, travels } of await syncing()) {
        if (!travels) {
          // Left alone, not missing: a missing item would be deleted on the other computers.
          out.push({ id: options.id(item), teamId: teamOf(item), value: {}, localOnly: true });
          continue;
        }
        const value = toValue(item);
        delete value[TEAM_FIELD];
        out.push({
          id: options.id(item),
          teamId: teamOf(item),
          value: options.secrets
            ? await openEnvelopes(value, options.secrets.open as never)
            : value,
        });
      }
      return out;
    },

    async apply(incoming: LocalItem): Promise<void> {
      const value = options.secrets
        ? await sealSecrets(incoming.value, options.secrets.seal)
        : incoming.value;
      const existing =
        (await options.list()).find((item) => options.id(item) === incoming.id) ?? null;
      const next = fromValue(value, existing) as Record<string, unknown>;
      // "Keep both" applies the other computer's value under a new id; every store keys on `id`.
      if (options.id(next as T) !== incoming.id) next.id = incoming.id;
      if (incoming.teamId === null) delete next[TEAM_FIELD];
      else next[TEAM_FIELD] = incoming.teamId;
      await options.put(next as T);
      options.afterWrite?.([incoming.id]);
    },

    async remove(id: string): Promise<void> {
      if (!(await syncing()).some(({ item, travels }) => travels && options.id(item) === id))
        return;
      await options.remove(id);
      options.afterWrite?.([id]);
    },
  };
}
