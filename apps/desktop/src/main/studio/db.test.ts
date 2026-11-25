import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALWAYS_TRUE, hostileSqlValues } from '../../test/main/hostileSqlInput';
import { closeSqliteHandlesAfterEach } from '../../test/main/sqliteHandles';
import { openBetterSqlite } from './db';

/**
 * Studio's SQLite port over better-sqlite3 (the node:sqlite shim here). It writes no SQL of its
 * own, so what matters is that the parameters Studio binds reach the driver as parameters.
 */

const dirs: string[] = [];
const close = closeSqliteHandlesAfterEach();
afterEach(() => {
  close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'runova-studio-db-'));
  dirs.push(dir);
  return openBetterSqlite(join(dir, 'studio.db'));
}

describe('openBetterSqlite', () => {
  it('binds hostile values as data in run, get and all', () => {
    const db = open();
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    insert.run('plain', 'kept');
    const hostile = hostileSqlValues('meta');
    for (const text of hostile) insert.run(text, text);

    const byKey = db.prepare('SELECT value FROM meta WHERE key = ?');
    for (const text of hostile) expect(byKey.get(text)).toEqual({ value: text });
    expect(byKey.get(`${ALWAYS_TRUE} --`)).toBeUndefined();
    expect(db.prepare('SELECT key FROM meta WHERE key = ?').all(ALWAYS_TRUE)).toEqual([
      { key: ALWAYS_TRUE },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM meta').get()).toEqual({ n: hostile.length + 1 });
  });

  it('rolls a transaction back when the work throws', () => {
    const db = open();
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(ALWAYS_TRUE, 'x');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM meta').get()).toEqual({ n: 0 });
  });
});
