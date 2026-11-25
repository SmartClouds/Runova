import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StoredEnvFileVersion } from '../shared/apiTypes';
import { ALWAYS_TRUE, dropTable, hostileSqlValues } from '../test/main/hostileSqlInput';
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

describe('hostile input is data, never SQL', () => {
  const hostile = hostileSqlValues('env_file_versions');

  it('stores hostile ids and names verbatim and finds each only through its own file', async () => {
    const db = await loadDb();
    const bystander = db.add(
      version({ fileId: 'plain', projectId: 'plain', environmentId: 'plain' }),
    );
    const added = hostile.map((text) =>
      db.add(version({ projectId: text, environmentId: text, fileId: text, fileName: text })),
    );

    for (const [index, text] of hostile.entries()) {
      expect(db.list(text).map((one) => one.id)).toEqual([added[index]!.id]);
      expect(db.get(text, added[index]!.id)).toEqual(added[index]);
    }
    expect(db.get(ALWAYS_TRUE, bystander.id)).toBeNull();
    expect(db.get('plain', ALWAYS_TRUE)).toBeNull();
    expect(db.list('plain')).toHaveLength(1);
    expect(db.exportAll()).toHaveLength(hostile.length + 1);
  });

  it('counts only the files it literally names, however their ids look', async () => {
    const db = await loadDb();
    db.add(version({ fileId: 'plain' }));
    db.add(version({ fileId: ALWAYS_TRUE }));
    db.add(version({ fileId: ALWAYS_TRUE }));

    const counts = db.countByFile([ALWAYS_TRUE, dropTable('env_file_versions'), '") OR 1=1 --']);

    expect([...counts]).toEqual([[ALWAYS_TRUE, 2]]);
    expect(db.exportAll()).toHaveLength(3);
  });

  it('removes only what the hostile id names and keeps projects listed by hostile ids', async () => {
    const db = await loadDb();
    const plain = db.add(version({ fileId: 'plain', environmentId: 'plain', projectId: 'plain' }));
    const odd = db.add(version({ fileId: 'odd', environmentId: 'odd', projectId: ALWAYS_TRUE }));

    for (const text of hostile.filter((one) => one !== ALWAYS_TRUE)) {
      db.removeForFile(text);
      db.removeForEnvironment(text);
    }
    expect(db.exportAll()).toHaveLength(2);

    expect(db.retainProjects([ALWAYS_TRUE, dropTable('env_file_versions')])).toBe(1);
    expect(db.exportAll()).toEqual([odd]);
    expect(db.get('plain', plain.id)).toBeNull();
  });

  it('restores a backup full of hostile text without running any of it', async () => {
    const db = await loadDb();
    const incoming: StoredEnvFileVersion[] = hostile.map((text, index) => ({
      ...version({ projectId: text, environmentId: text, fileId: text, fileName: text }),
      id: text,
      replacedAt: 10 + index,
    }));

    db.replaceAll(incoming);

    expect(db.exportAll()).toEqual([...incoming].reverse());
  });
});
