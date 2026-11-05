import type { EncryptionPolicy, SyncCollection } from '@runova/core';
import type { WireRecord } from './syncDb';

/** A scope as the server lists it: the account's own, or a team's. */
export interface SyncScopeInfo {
  id: number;
  kind: 'personal' | 'team';
  teamId: number | null;
  name: string;
  /** False for a team Viewer: it reads and never pushes. */
  canWrite: boolean;
  /** May change the key and the policy: the account itself, or a team's Owners and Admins. */
  canManage: boolean;
  /** Changes when the cloud copy is reset; this computer then starts the scope again. */
  epoch: number;
  latestRevision: number;
  /** The scope has an end-to-end key (its envelope is on the server), at this version. */
  keyVersion: number | null;
  policy: EncryptionPolicy;
}

export interface PushRecord {
  collection: string;
  itemId: string;
  baseRevision: number;
  deleted: boolean;
  encryption: 'none' | 'e2ee';
  keyVersion: number | null;
  payload: string | null;
}

export interface PushResult {
  accepted: { collection: string; itemId: string; revision: number }[];
  /** The server's copy of each record whose base revision was stale. */
  conflicts: WireRecord[];
}

export interface ChangesPage {
  records: WireRecord[];
  /** The cursor to ask from next time. */
  next: number;
  more: boolean;
}

/** The website API's sync routes, or a fake of them. */
export interface SyncApi {
  scopes(): Promise<SyncScopeInfo[]>;
  changes(scopeId: number, since: number, limit: number): Promise<ChangesPage>;
  push(scopeId: number, records: PushRecord[]): Promise<PushResult>;
}

/** An item as a store holds it, with its secrets opened. */
export interface LocalItem {
  id: string;
  /** The team it is shared with, or null for the person's own. */
  teamId: number | null;
  value: Record<string, unknown>;
  /**
   * Kept on this computer and left alone by sync: never pushed, and never read as deleted
   * because it is missing (an API collection too large to sync, a connection to a local file).
   */
  localOnly?: boolean;
}

/**
 * How the engine reads and writes one collection. Writes go through the store's own service (and
 * its write queue), so the engine is never a second writer. `apply` gets the whole item back:
 * the shared fields from the other computer joined with this computer's own fields.
 */
export interface SyncAdapter {
  collection: SyncCollection;
  /** The area the renderer refreshes after a change (`useAiAccessDataSync`). */
  area: string;
  /** False while the store can not be read or written, such as a locked Vault. */
  ready?: () => boolean;
  list: () => Promise<LocalItem[]>;
  apply: (item: LocalItem) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** For "Keep both": the other computer's version under a new id and a name that says so. */
  duplicate?: (value: Record<string, unknown>) => Record<string, unknown>;
}

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out';

export interface SyncStatus {
  phase: SyncPhase;
  lastSyncedAt: number | null;
  error: string | null;
  conflicts: number;
  /** Scopes with sealed records this computer can not open yet: a key is needed. */
  needsKey: number[];
}
