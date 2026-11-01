import { ipcRenderer } from 'electron';
import type {
  DatabaseBackupFile,
  DatabaseBackupProgress,
  DatabaseConnectCandidateInput,
  DatabaseConnection,
  DatabaseConnectResult,
  DatabaseDiscovery,
  DatabaseSaveInput,
  DbAiContext,
  DbAiContextInput,
  DbListObjectsInput,
  DbObjectNode,
  DbObjectRef,
  DbQueryInput,
  DbQueryOutcome,
  DbReadRowsInput,
  DbRowsPage,
  DbSetting,
  DbTableDescription,
  DbUser,
} from '../shared/databaseTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * The Database section (E45). A container on a server needs a step-up before its environment is
 * read: `connectCandidate` then fails with `[core:stepUpRequired]`, and is called again with the
 * password or a code.
 */
type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

export function createDatabase(subscribe: Subscribe) {
  return {
    listConnections: (): Promise<DatabaseConnection[]> =>
      ipcRenderer.invoke(IPC.database.listConnections),
    saveConnection: (input: DatabaseSaveInput): Promise<DatabaseConnection> =>
      ipcRenderer.invoke(IPC.database.saveConnection, input),
    removeConnection: (connectionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.database.removeConnection, connectionId),
    /** Database containers on a server, or in this computer's Docker for null. */
    discover: (serverId: string | null): Promise<DatabaseDiscovery> =>
      ipcRenderer.invoke(IPC.database.discover, { serverId }),
    connectCandidate: (input: DatabaseConnectCandidateInput): Promise<DatabaseConnectResult> =>
      ipcRenderer.invoke(IPC.database.connectCandidate, input),
    connect: (connectionId: string, password?: string): Promise<DatabaseConnectResult> =>
      ipcRenderer.invoke(IPC.database.connect, connectionId, password),
    disconnect: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.database.disconnect, sessionId),
    listObjects: (input: DbListObjectsInput): Promise<DbObjectNode[]> =>
      ipcRenderer.invoke(IPC.database.listObjects, input),
    describe: (sessionId: string, ref: DbObjectRef): Promise<DbTableDescription> =>
      ipcRenderer.invoke(IPC.database.describe, sessionId, ref),
    readRows: (input: DbReadRowsInput): Promise<DbRowsPage> =>
      ipcRenderer.invoke(IPC.database.readRows, input),
    query: (input: DbQueryInput): Promise<DbQueryOutcome> =>
      ipcRenderer.invoke(IPC.database.query, input),
    aiContext: (input: DbAiContextInput): Promise<DbAiContext> =>
      ipcRenderer.invoke(IPC.database.aiContext, input),
    settings: (sessionId: string): Promise<DbSetting[]> =>
      ipcRenderer.invoke(IPC.database.settings, sessionId),
    users: (sessionId: string): Promise<DbUser[]> =>
      ipcRenderer.invoke(IPC.database.users, sessionId),
    listBackups: (connectionId: string): Promise<DatabaseBackupFile[]> =>
      ipcRenderer.invoke(IPC.database.listBackups, connectionId),
    backup: (connectionId: string): Promise<DatabaseBackupFile> =>
      ipcRenderer.invoke(IPC.database.backup, connectionId),
    restore: (connectionId: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.database.restore, connectionId, name),
    restoreFromFile: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.database.restoreFromFile, connectionId),
    removeBackup: (connectionId: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.database.removeBackup, connectionId, name),
    revealBackup: (connectionId: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.database.revealBackup, connectionId, name),
    onBackupProgress: (callback: (event: DatabaseBackupProgress) => void): (() => void) =>
      subscribe(IPC.database.onBackupProgress, callback),
    cancelQuery: (sessionId: string, queryId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.database.cancelQuery, sessionId, queryId),
  };
}
