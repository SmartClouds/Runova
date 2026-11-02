import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';

/**
 * The sqlite-backed stores open their file once and never close it, and Windows refuses to remove
 * a folder that still holds an open file, so the harness's cleanup would throw EPERM after any
 * test that reached a database. Recording each connection as it prepares its first statement is
 * enough to close them all before the temp folder goes away.
 *
 * Call it after `useTempUserData()`: after-hooks run in reverse, so the handles close first.
 * Returns the closer, for a test that wants to reopen a database from disk.
 */
export function closeSqliteHandlesAfterEach(): () => void {
  const openDatabases = new Set<DatabaseSync>();
  const nativePrepare = DatabaseSync.prototype.prepare;
  const nativeExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.prepare = function trackedPrepare(this: DatabaseSync, sql: string) {
    openDatabases.add(this);
    return nativePrepare.call(this, sql);
  };
  DatabaseSync.prototype.exec = function trackedExec(this: DatabaseSync, sql: string) {
    openDatabases.add(this);
    return nativeExec.call(this, sql);
  };

  function closeAll(): void {
    for (const database of openDatabases) {
      try {
        database.close();
      } catch {
        // Already closed, or never opened. Either way nothing is left holding the folder.
      }
    }
    openDatabases.clear();
  }

  afterEach(closeAll);
  return closeAll;
}
