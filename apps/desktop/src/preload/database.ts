import { ipcRenderer } from 'electron';
import type {
  DatabaseConnectCandidateInput,
  DatabaseConnection,
  DatabaseConnectResult,
  DatabaseDiscovery,
  DatabaseSaveInput,
  DbListObjectsInput,
  DbObjectNode,
  DbObjectRef,
  DbQueryInput,
  DbQueryOutcome,
  DbReadRowsInput,
  DbRowsPage,
  DbTableDescription,
} from '../shared/databaseTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * The Database section (E44). A container on a server needs a step-up before its environment is
 * read: `connectCandidate` then fails with `[core:stepUpRequired]`, and is called again with the
 * password or a code.
 */
export function createDatabase() {
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
    cancelQuery: (sessionId: string, queryId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.database.cancelQuery, sessionId, queryId),
  };
}
