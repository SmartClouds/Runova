import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SyncedState } from '@runova/core';
import Database from 'better-sqlite3';

/**
 * What this computer remembers between syncs (E48.13), in sync-state.db: each scope's cursor in
 * the server's changes feed, each item's revision and hash at the last sync, records the server
 * sent that wait for a key, and conflicts waiting for the person. Raw records are kept as the
 * server sent them, so a secret in one is still sealed (or was never sent).
 */

export interface WireRecord {
  collection: string;
  itemId: string;
  revision: number;
  deleted: boolean;
  encryption: 'none' | 'e2ee';
  keyVersion: number | null;
  /** JSON text of the payload; see wire.ts. Null for a delete. */
  payload: string | null;
  updatedAt: string;
}

export interface StoredConflict {
  scopeId: number;
  collection: string;
  itemId: string;
  remote: WireRecord;
  /** The item was deleted here. */
  localDeleted: boolean;
  detectedAt: number;
}

export function openSyncDb(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scopes (
      scope_id INTEGER PRIMARY KEY,
      cursor INTEGER NOT NULL DEFAULT 0,
      epoch INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS items (
      scope_id INTEGER NOT NULL,
      collection TEXT NOT NULL,
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      hash TEXT,
      PRIMARY KEY (scope_id, collection, item_id)
    );
    CREATE TABLE IF NOT EXISTS pending (
      scope_id INTEGER NOT NULL,
      collection TEXT NOT NULL,
      item_id TEXT NOT NULL,
      record TEXT NOT NULL,
      PRIMARY KEY (scope_id, collection, item_id)
    );
    CREATE TABLE IF NOT EXISTS item_teams (
      collection TEXT NOT NULL,
      item_id TEXT NOT NULL,
      team_id INTEGER,
      PRIMARY KEY (collection, item_id)
    );
    CREATE TABLE IF NOT EXISTS conflicts (
      scope_id INTEGER NOT NULL,
      collection TEXT NOT NULL,
      item_id TEXT NOT NULL,
      record TEXT NOT NULL,
      local_deleted INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      PRIMARY KEY (scope_id, collection, item_id)
    );
  `);

  const cursorOf = db.prepare('SELECT cursor FROM scopes WHERE scope_id = ?');
  const epochOf = db.prepare('SELECT epoch FROM scopes WHERE scope_id = ?');
  const setEpoch = db.prepare(
    'INSERT INTO scopes (scope_id, cursor, epoch) VALUES (?, 0, ?) ON CONFLICT(scope_id) DO UPDATE SET cursor = 0, epoch = excluded.epoch',
  );
  const teamOf = db.prepare('SELECT team_id FROM item_teams WHERE collection = ? AND item_id = ?');
  const setTeam = db.prepare(
    `INSERT INTO item_teams (collection, item_id, team_id) VALUES (?, ?, ?)
     ON CONFLICT(collection, item_id) DO UPDATE SET team_id = excluded.team_id`,
  );
  const dropTeam = db.prepare('DELETE FROM item_teams WHERE collection = ? AND item_id = ?');
  const markChanged = db.prepare(
    "UPDATE items SET hash = 'resend' WHERE scope_id = ? AND hash IS NOT NULL",
  );
  const forgetScope = [
    db.prepare('DELETE FROM items WHERE scope_id = ?'),
    db.prepare('DELETE FROM pending WHERE scope_id = ?'),
    db.prepare('DELETE FROM conflicts WHERE scope_id = ?'),
  ];
  const setCursor = db.prepare(
    'INSERT INTO scopes (scope_id, cursor) VALUES (?, ?) ON CONFLICT(scope_id) DO UPDATE SET cursor = excluded.cursor',
  );
  const itemsOf = db.prepare(
    'SELECT item_id, revision, hash FROM items WHERE scope_id = ? AND collection = ?',
  );
  const putItem = db.prepare(
    `INSERT INTO items (scope_id, collection, item_id, revision, hash) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, collection, item_id) DO UPDATE SET revision = excluded.revision, hash = excluded.hash`,
  );
  const dropItem = db.prepare(
    'DELETE FROM items WHERE scope_id = ? AND collection = ? AND item_id = ?',
  );
  const putPending = db.prepare(
    `INSERT INTO pending (scope_id, collection, item_id, record) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope_id, collection, item_id) DO UPDATE SET record = excluded.record`,
  );
  const pendingOf = db.prepare('SELECT record FROM pending WHERE scope_id = ?');
  const dropPending = db.prepare(
    'DELETE FROM pending WHERE scope_id = ? AND collection = ? AND item_id = ?',
  );
  const putConflict = db.prepare(
    `INSERT INTO conflicts (scope_id, collection, item_id, record, local_deleted, detected_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_id, collection, item_id) DO UPDATE SET record = excluded.record, local_deleted = excluded.local_deleted`,
  );
  const allConflicts = db.prepare(
    'SELECT scope_id, collection, item_id, record, local_deleted, detected_at FROM conflicts ORDER BY detected_at',
  );
  const dropConflict = db.prepare(
    'DELETE FROM conflicts WHERE scope_id = ? AND collection = ? AND item_id = ?',
  );

  return {
    cursor(scopeId: number): number {
      return (cursorOf.get(scopeId) as { cursor: number } | undefined)?.cursor ?? 0;
    },
    setCursor(scopeId: number, cursor: number): void {
      setCursor.run(scopeId, cursor);
    },
    epoch(scopeId: number): number {
      return (epochOf.get(scopeId) as { epoch: number } | undefined)?.epoch ?? 0;
    },
    /**
     * Every item of the scope counts as changed here, so the next push sends it again on its own
     * revision: after a new key, to seal it under that key.
     */
    markScopeChanged(scopeId: number): void {
      markChanged.run(scopeId);
    },
    /** A new epoch: forget the scope's cursor, revisions, waiting records and conflicts. */
    startEpoch(scopeId: number, epoch: number): void {
      for (const statement of forgetScope) statement.run(scopeId);
      setEpoch.run(scopeId, epoch);
    },
    synced(scopeId: number, collection: string): Map<string, SyncedState> {
      const rows = itemsOf.all(scopeId, collection) as {
        item_id: string;
        revision: number;
        hash: string | null;
      }[];
      return new Map(rows.map((r) => [r.item_id, { revision: r.revision, hash: r.hash }]));
    },
    setSynced(scopeId: number, collection: string, itemId: string, state: SyncedState): void {
      putItem.run(scopeId, collection, itemId, state.revision, state.hash);
    },
    forgetSynced(scopeId: number, collection: string, itemId: string): void {
      dropItem.run(scopeId, collection, itemId);
    },
    addPending(scopeId: number, record: WireRecord): void {
      putPending.run(scopeId, record.collection, record.itemId, JSON.stringify(record));
    },
    pending(scopeId: number): WireRecord[] {
      return (pendingOf.all(scopeId) as { record: string }[]).map(
        (r) => JSON.parse(r.record) as WireRecord,
      );
    },
    dropPending(scopeId: number, collection: string, itemId: string): void {
      dropPending.run(scopeId, collection, itemId);
    },
    addConflict(conflict: StoredConflict): void {
      putConflict.run(
        conflict.scopeId,
        conflict.collection,
        conflict.itemId,
        JSON.stringify(conflict.remote),
        conflict.localDeleted ? 1 : 0,
        conflict.detectedAt,
      );
    },
    conflicts(): StoredConflict[] {
      return (
        allConflicts.all() as {
          scope_id: number;
          collection: string;
          item_id: string;
          record: string;
          local_deleted: number;
          detected_at: number;
        }[]
      ).map((r) => ({
        scopeId: r.scope_id,
        collection: r.collection,
        itemId: r.item_id,
        remote: JSON.parse(r.record) as WireRecord,
        localDeleted: r.local_deleted === 1,
        detectedAt: r.detected_at,
      }));
    },
    dropConflict(scopeId: number, collection: string, itemId: string): void {
      dropConflict.run(scopeId, collection, itemId);
    },
    /** The team an item belongs to: a team id, null for the person's own, undefined when unknown. */
    teamOf(collection: string, itemId: string): number | null | undefined {
      const row = teamOf.get(collection, itemId) as { team_id: number | null } | undefined;
      return row ? row.team_id : undefined;
    },
    setTeam(collection: string, itemId: string, teamId: number | null): void {
      setTeam.run(collection, itemId, teamId);
    },
    dropTeam(collection: string, itemId: string): void {
      dropTeam.run(collection, itemId);
    },
    /** Everything, for signing out: the next account starts clean. */
    clear(): void {
      db.exec(
        'DELETE FROM scopes; DELETE FROM items; DELETE FROM pending; DELETE FROM conflicts; DELETE FROM item_teams;',
      );
    },
    close(): void {
      db.close();
    },
  };
}

export type SyncDb = ReturnType<typeof openSyncDb>;
