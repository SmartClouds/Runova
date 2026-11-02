import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StoredEnvFileVersion } from '../shared/apiTypes';
import { useTempUserData } from '../test/main/ipcHarness';
import { closeSqliteHandlesAfterEach } from '../test/main/sqliteHandles';

/**
 * Env file history: every version an env file had before a save replaced it. The history is never
 * pruned, so what matters here is that each version stays tied to its file, reads back newest
 * first, and goes away with the file, environment or project it belongs to.
 */

const userData = useTempUserData();
const closeDatabases = closeSqliteHandlesAfterEach();

type Db = typeof import('./envFileHistoryDb')['envFileHistoryDb'];

async function loadDb(): Promise<Db> {
  return (await import('./envFileHistoryDb')).envFileHistoryDb;
}

type NewVersion = Omit<StoredEnvFileVersion, 'id'>;

function version(overrides: Partial<NewVersion> = {}): NewVersion {
  return {
    projectId: 'p1',
    environmentId: 'e1',
    fileId: 'f1',
    fileName: '.env',
    keyCount: 1,
    origin: 'edited',
    savedAt: 1_000,
    replacedAt: 2_000,
    contentEnvelope: { mode: 'passphrase', iv: 'iv', authTag: 'tag', ciphertext: 'sealed-1' },
    ...overrides,
  };
}

describe('add and list', () => {
  it('creates the database on first use and reads the version back', async () => {
    const db = await loadDb();
    const stored = db.add(version());

    expect(existsSync(join(userData.dir, 'data', 'env-file-history.db'))).toBe(true);
    expect(stored.id).toMatch(/\S+/);
    expect(db.list('f1')).toEqual([
      {
        id: stored.id,
        fileName: '.env',
        keyCount: 1,
        origin: 'edited',
        savedAt: 1_000,
        replacedAt: 2_000,
      },
    ]);
    expect(db.get('f1', stored.id)).toEqual(stored);
  });

  it('lists newest first, two versions replaced in the same millisecond in insert order', async () => {
    const db = await loadDb();
    const oldest = db.add(version({ replacedAt: 1_000 }));
    const first = db.add(version({ replacedAt: 5_000 }));
    const second = db.add(version({ replacedAt: 5_000 }));

    expect(db.list('f1').map((one) => one.id)).toEqual([second.id, first.id, oldest.id]);
  });

  it('keeps a version without an origin, as files saved before history had none', async () => {
    const db = await loadDb();
    const stored = db.add(version({ origin: undefined }));
    expect(db.list('f1')[0].origin).toBeUndefined();
    expect(db.get('f1', stored.id)?.origin).toBeUndefined();
  });

  it('keeps every version, with no cap', async () => {
    const db = await loadDb();
    for (let index = 0; index < 250; index++) db.add(version({ replacedAt: index }));
    expect(db.list('f1')).toHaveLength(250);
  });

  it('reopens a database that already holds versions', async () => {
    const first = await loadDb();
    const stored = first.add(version());
    closeDatabases();

    vi.resetModules();
    const second = await loadDb();
    expect(second.get('f1', stored.id)).toEqual(stored);
  });
});

describe('get', () => {
  it('only finds a version through its own file', async () => {
    const db = await loadDb();
    const stored = db.add(version());
    expect(db.get('f2', stored.id)).toBeNull();
    expect(db.get('f1', 'missing')).toBeNull();
  });
});

describe('countByFile', () => {
  it('counts the versions of each asked file, leaving the rest out', async () => {
    const db = await loadDb();
    db.add(version());
    db.add(version());
    db.add(version({ fileId: 'f2' }));
    db.add(version({ fileId: 'f3' }));

    const counts = db.countByFile(['f1', 'f2', 'f9']);
    expect(Object.fromEntries(counts)).toEqual({ f1: 2, f2: 1 });
    expect(db.countByFile([]).size).toBe(0);
  });
});

describe('removal', () => {
  it('removes one file, one environment, or every project not kept', async () => {
    const db = await loadDb();
    db.add(version());
    db.add(version({ fileId: 'f2' }));
    db.add(version({ environmentId: 'e2', fileId: 'f3' }));
    db.add(version({ projectId: 'p2', environmentId: 'e3', fileId: 'f4' }));

    db.removeForFile('f1');
    expect(db.list('f1')).toEqual([]);
    expect(db.list('f2')).toHaveLength(1);

    db.removeForEnvironment('e1');
    expect(db.list('f2')).toEqual([]);
    expect(db.list('f3')).toHaveLength(1);

    expect(db.retainProjects(['p1'])).toBe(1);
    expect(db.list('f4')).toEqual([]);
    expect(db.list('f3')).toHaveLength(1);
  });

  it('keeps nothing when no project is kept', async () => {
    const db = await loadDb();
    db.add(version());
    expect(db.retainProjects([])).toBe(1);
    expect(db.list('f1')).toEqual([]);
  });
});

describe('backup', () => {
  it('exports everything and replaces the whole table on restore', async () => {
    const db = await loadDb();
    const kept = db.add(version());
    expect(db.exportAll()).toEqual([kept]);

    const incoming: StoredEnvFileVersion = { ...version({ fileId: 'f7' }), id: 'v-restored' };
    db.replaceAll([incoming]);
    expect(db.exportAll()).toEqual([incoming]);
    expect(db.list('f1')).toEqual([]);
  });
});
