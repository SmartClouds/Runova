import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALWAYS_TRUE, hostileSqlValues } from '../../test/main/hostileSqlInput';
import { closeSqliteHandlesAfterEach } from '../../test/main/sqliteHandles';
import { openSyncDb, type WireRecord } from './syncDb';

/**
 * The sync state store takes collection names, item ids and whole records from the server, so
 * every one of them has to stay data however it looks. Each test sends hostile text through the
 * public functions and checks it comes back verbatim and touches nothing it does not name.
 */

const dirs: string[] = [];
const close = closeSqliteHandlesAfterEach();
afterEach(() => {
  close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'runova-sync-db-'));
  dirs.push(dir);
  return openSyncDb(join(dir, 'sync-state.db'));
}

function wire(collection: string, itemId: string, payload: string | null): WireRecord {
  return {
    collection,
    itemId,
    revision: 3,
    deleted: payload === null,
    encryption: 'none',
    keyVersion: null,
    payload,
    updatedAt: '2026-11-25T00:00:00.000Z',
  };
}

describe('hostile input is data, never SQL', () => {
  const hostile = [
    ...new Set(
      ['items', 'pending', 'conflicts', 'item_teams', 'scopes'].flatMap((table) =>
        hostileSqlValues(table),
      ),
    ),
  ];

  it('keeps synced revisions under hostile collection names and item ids apart', () => {
    const db = open();
    db.setSynced(1, 'plain', 'plain', { revision: 1, hash: 'h' });
    for (const text of hostile) db.setSynced(1, text, text, { revision: 2, hash: text });

    for (const text of hostile) {
      expect([...db.synced(1, text)]).toEqual([[text, { revision: 2, hash: text }]]);
    }
    expect([...db.synced(1, 'plain')]).toEqual([['plain', { revision: 1, hash: 'h' }]]);

    for (const text of hostile) db.forgetSynced(1, 'plain', text);
    expect([...db.synced(1, 'plain')]).toHaveLength(1);
    db.forgetSynced(1, ALWAYS_TRUE, ALWAYS_TRUE);
    expect([...db.synced(1, ALWAYS_TRUE)]).toEqual([]);
    expect([...db.synced(1, 'plain')]).toHaveLength(1);
  });

  it('stores waiting records with hostile fields verbatim and drops only the one named', () => {
    const db = open();
    const plain = wire('plain', 'plain', '{"a":1}');
    db.addPending(1, plain);
    const records = hostile.map((text) => wire(text, text, text));
    for (const record of records) db.addPending(1, record);

    expect(db.pending(1)).toHaveLength(records.length + 1);
    expect(db.pending(1)).toEqual(expect.arrayContaining([plain, ...records]));

    for (const text of hostile) db.dropPending(1, 'plain', text);
    expect(db.pending(1)).toHaveLength(records.length + 1);
    db.dropPending(1, ALWAYS_TRUE, ALWAYS_TRUE);
    expect(db.pending(1)).toHaveLength(records.length);
    expect(db.pending(1)).toContainEqual(plain);
    expect(db.pending(1).map((one) => one.itemId)).not.toContain(ALWAYS_TRUE);
  });

  it('stores conflicts with hostile fields verbatim and drops only the one named', () => {
    const db = open();
    const plain = {
      scopeId: 1,
      collection: 'plain',
      itemId: 'plain',
      remote: wire('plain', 'plain', null),
      localDeleted: false,
      detectedAt: 1,
    };
    db.addConflict(plain);
    const conflicts = hostile.map((text, index) => ({
      scopeId: 1,
      collection: text,
      itemId: text,
      remote: wire(text, text, text),
      localDeleted: true,
      detectedAt: 2 + index,
    }));
    for (const conflict of conflicts) db.addConflict(conflict);

    expect(db.conflicts()).toEqual([plain, ...conflicts]);

    db.dropConflict(1, ALWAYS_TRUE, ALWAYS_TRUE);
    expect(db.conflicts()).toHaveLength(conflicts.length);
    expect(db.conflicts()[0]).toEqual(plain);
    expect(db.conflicts().map((one) => one.itemId)).not.toContain(ALWAYS_TRUE);
  });

  it('keeps team assignments under hostile names apart', () => {
    const db = open();
    db.setTeam('plain', 'plain', 7);
    for (const text of hostile) db.setTeam(text, text, null);

    for (const text of hostile) expect(db.teamOf(text, text)).toBeNull();
    expect(db.teamOf('plain', ALWAYS_TRUE)).toBeUndefined();
    expect(db.teamOf('plain', 'plain')).toBe(7);

    db.dropTeam(ALWAYS_TRUE, ALWAYS_TRUE);
    expect(db.teamOf(ALWAYS_TRUE, ALWAYS_TRUE)).toBeUndefined();
    expect(db.teamOf('plain', 'plain')).toBe(7);
  });

  it('forgets only the scope it is told to', () => {
    const db = open();
    db.setCursor(1, 10);
    db.setSynced(1, ALWAYS_TRUE, 'a', { revision: 1, hash: 'h' });
    db.setSynced(2, ALWAYS_TRUE, 'b', { revision: 1, hash: 'h' });

    db.startEpoch(2, 5);

    expect(db.cursor(1)).toBe(10);
    expect([...db.synced(1, ALWAYS_TRUE)]).toHaveLength(1);
    expect([...db.synced(2, ALWAYS_TRUE)]).toEqual([]);
    expect(db.epoch(2)).toBe(5);
  });
});
