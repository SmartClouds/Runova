import type { SyncCollection } from '@runova/core';
import type { LocalItem, SyncAdapter } from '../types';
import { openEnvelopes, sealSecrets } from './envelopes';

/**
 * The field a stored item keeps its team in when it is shared with one (E48.17). It is not part of
 * what syncs: the scope the item is pushed to says which team it belongs to.
 */
export const TEAM_FIELD = 'syncTeamId';

export interface SecretPort {
  /** Opens one of this computer's sealed secrets. Throws while it is locked. */
  open: (envelope: never) => Promise<string>;
  /** Seals a secret the way this computer's stores do. */
  seal: (plain: string) => Promise<unknown>;
}

export interface ArrayStoreOptions<T> {
  collection: SyncCollection;
  area: string;
  read: () => Promise<T[]>;
  write: (items: T[]) => Promise<void>;
  id: (item: T) => string;
  secrets?: SecretPort;
  ready?: () => boolean;
  /**
   * The item as it syncs, before the field split. Most stores sync the item as it is stored;
   * a store with fields that must never travel (caches, pins) drops them here.
   */
  toValue?: (item: T) => Record<string, unknown>;
  /**
   * The item to store from what arrived, given what was here before (null for a new one). The
   * default takes the value as it is, with the defaults the store fills on read.
   */
  fromValue?: (value: Record<string, unknown>, existing: T | null) => T;
  /** After a write from another computer, such as a broadcast to the renderer. */
  afterWrite?: (ids: string[]) => void;
  /** Runs after an item is removed here, for the stores that clean up what hung off it. */
  afterRemove?: (id: string) => Promise<void>;
  duplicate?: (value: Record<string, unknown>) => Record<string, unknown>;
}

function teamOf(item: unknown): number | null {
  const team = (item as Record<string, unknown>)[TEAM_FIELD];
  return typeof team === 'number' ? team : null;
}

/**
 * An adapter for a store that reads and writes a whole array of items, which is most of them.
 * Secrets are opened for the sync and sealed again on the way in (envelopes.ts).
 */
export function arrayStoreAdapter<T>(options: ArrayStoreOptions<T>): SyncAdapter {
  const toValue = options.toValue ?? ((item: T) => ({ ...(item as Record<string, unknown>) }));
  const fromValue = options.fromValue ?? ((value: Record<string, unknown>) => value as T);

  async function open(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    return options.secrets ? openEnvelopes(value, options.secrets.open as never) : value;
  }

  async function seal(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    return options.secrets ? sealSecrets(value, options.secrets.seal) : value;
  }

  return {
    collection: options.collection,
    area: options.area,
    ...(options.ready ? { ready: options.ready } : {}),
    ...(options.duplicate ? { duplicate: options.duplicate } : {}),

    async list(): Promise<LocalItem[]> {
      const items = await options.read();
      const out: LocalItem[] = [];
      for (const item of items) {
        const value = toValue(item);
        delete value[TEAM_FIELD];
        out.push({ id: options.id(item), teamId: teamOf(item), value: await open(value) });
      }
      return out;
    },

    async apply(incoming: LocalItem): Promise<void> {
      const sealed = await seal(incoming.value);
      const items = await options.read();
      const index = items.findIndex((item) => options.id(item) === incoming.id);
      const existing = index >= 0 ? (items[index] as T) : null;
      const next = fromValue(sealed, existing) as Record<string, unknown>;
      // "Keep both" applies the other computer's value under a new id; every store keys on `id`.
      if (options.id(next as T) !== incoming.id) next.id = incoming.id;
      if (incoming.teamId === null) delete next[TEAM_FIELD];
      else next[TEAM_FIELD] = incoming.teamId;
      if (index >= 0) items[index] = next as T;
      else items.push(next as T);
      await options.write(items);
      options.afterWrite?.([incoming.id]);
    },

    async remove(id: string): Promise<void> {
      const items = await options.read();
      const next = items.filter((item) => options.id(item) !== id);
      if (next.length === items.length) return;
      await options.write(next);
      await options.afterRemove?.(id);
      options.afterWrite?.([id]);
    },
  };
}

/** Moves an item to a team (or back to the person's own, with null). The next sync moves it on the server. */
export async function setItemTeam<T>(
  options: Pick<ArrayStoreOptions<T>, 'read' | 'write' | 'id'>,
  id: string,
  teamId: number | null,
): Promise<boolean> {
  const items = await options.read();
  const item = items.find((each) => options.id(each) === id) as Record<string, unknown> | undefined;
  if (!item) return false;
  if (teamId === null) delete item[TEAM_FIELD];
  else item[TEAM_FIELD] = teamId;
  await options.write(items);
  return true;
}
