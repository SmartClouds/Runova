import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { app } from 'electron';
import type {
  EnvFileOrigin,
  EnvFileVersionSummary,
  SecretEnvelope,
  StoredEnvFileVersion,
} from '../shared/apiTypes';

// Same native-binding caveat as blueprint revisions: better-sqlite3 is tied to the Electron ABI
// it was rebuilt for. See the `rebuild:native` script in package.json.
let db: Database.Database | null = null;

/**
 * Every version an env file had before a save replaced it. The contents are the same sealed
 * envelopes the environments store keeps, so nothing here is readable without the vault. The
 * history is kept in full (the user asked for no limit), which is why it lives in its own
 * database instead of the environments JSON that every list call reads.
 */

interface VersionRow {
  id: string;
  project_id: string;
  environment_id: string;
  file_id: string;
  file_name: string;
  key_count: number;
  origin: string | null;
  saved_at: number;
  replaced_at: number;
  content_envelope: string;
}

function summary(row: VersionRow): EnvFileVersionSummary {
  const entry: EnvFileVersionSummary = {
    id: row.id,
    fileName: row.file_name,
    keyCount: row.key_count,
    savedAt: row.saved_at,
    replacedAt: row.replaced_at,
  };
  if (row.origin) entry.origin = row.origin as EnvFileOrigin;
  return entry;
}

function stored(row: VersionRow): StoredEnvFileVersion {
  return {
    ...summary(row),
    projectId: row.project_id,
    environmentId: row.environment_id,
    fileId: row.file_id,
    contentEnvelope: JSON.parse(row.content_envelope) as SecretEnvelope,
  };
}

function getDb(): Database.Database {
  if (db) return db;
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'env-file-history.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS env_file_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      key_count INTEGER NOT NULL,
      origin TEXT,
      saved_at INTEGER NOT NULL,
      replaced_at INTEGER NOT NULL,
      content_envelope TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_env_file_versions_file
      ON env_file_versions(file_id, replaced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_env_file_versions_environment
      ON env_file_versions(environment_id);
    CREATE INDEX IF NOT EXISTS idx_env_file_versions_project
      ON env_file_versions(project_id);
  `);
  return db;
}

const INSERT = `INSERT INTO env_file_versions
  (id, project_id, environment_id, file_id, file_name, key_count, origin, saved_at, replaced_at,
   content_envelope)
  VALUES (@id, @projectId, @environmentId, @fileId, @fileName, @keyCount, @origin, @savedAt,
   @replacedAt, @contentEnvelope)`;

function params(version: StoredEnvFileVersion): Record<string, unknown> {
  return {
    id: version.id,
    projectId: version.projectId,
    environmentId: version.environmentId,
    fileId: version.fileId,
    fileName: version.fileName,
    keyCount: version.keyCount,
    origin: version.origin ?? null,
    savedAt: version.savedAt,
    replacedAt: version.replacedAt,
    contentEnvelope: JSON.stringify(version.contentEnvelope),
  };
}

export const envFileHistoryDb = {
  add(input: Omit<StoredEnvFileVersion, 'id'>): StoredEnvFileVersion {
    const version: StoredEnvFileVersion = { id: randomUUID(), ...input };
    if (version.origin === undefined) delete version.origin;
    getDb().prepare(INSERT).run(params(version));
    return version;
  },

  /** Newest first. */
  list(fileId: string): EnvFileVersionSummary[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM env_file_versions WHERE file_id = ?
         ORDER BY replaced_at DESC, rowid DESC`,
      )
      .all(fileId) as VersionRow[];
    return rows.map(summary);
  },

  /** Null when the version is gone or belongs to another file. */
  get(fileId: string, versionId: string): StoredEnvFileVersion | null {
    const row = getDb()
      .prepare('SELECT * FROM env_file_versions WHERE id = ? AND file_id = ?')
      .get(versionId, fileId) as VersionRow | undefined;
    return row ? stored(row) : null;
  },

  /** Version counts for the asked files. Files with no history are left out. */
  countByFile(fileIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (fileIds.length === 0) return counts;
    const rows = getDb()
      .prepare(
        `SELECT file_id, COUNT(*) AS count FROM env_file_versions
         WHERE file_id IN (SELECT value FROM json_each(?))
         GROUP BY file_id`,
      )
      .all(JSON.stringify(fileIds)) as Array<{ file_id: string; count: number }>;
    for (const row of rows) counts.set(row.file_id, Number(row.count));
    return counts;
  },

  removeForFile(fileId: string): void {
    getDb().prepare('DELETE FROM env_file_versions WHERE file_id = ?').run(fileId);
  },

  removeForEnvironment(environmentId: string): void {
    getDb().prepare('DELETE FROM env_file_versions WHERE environment_id = ?').run(environmentId);
  },

  /** Drops the history of every project not listed. Returns how many versions went. */
  retainProjects(projectIds: readonly string[]): number {
    const result = getDb()
      .prepare(
        `DELETE FROM env_file_versions
         WHERE project_id NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(JSON.stringify(projectIds));
    return Number(result.changes);
  },

  /** The whole table, for backup export. */
  exportAll(): StoredEnvFileVersion[] {
    const rows = getDb()
      .prepare('SELECT * FROM env_file_versions ORDER BY replaced_at DESC, rowid DESC')
      .all() as VersionRow[];
    return rows.map(stored);
  },

  /** Replaces the whole table, for backup restore. */
  replaceAll(versions: readonly StoredEnvFileVersion[]): void {
    const database = getDb();
    const insert = database.prepare(INSERT);
    database.transaction((rows: readonly StoredEnvFileVersion[]) => {
      database.prepare('DELETE FROM env_file_versions').run();
      for (const version of rows) insert.run(params(version));
    })(versions);
  },
};
