import { isDbEngine } from '@runova/core';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  DatabaseConnectCandidateInput,
  DatabaseSaveInput,
  DatabaseTarget,
  DbListObjectsInput,
  DbObjectKind,
  DbObjectRef,
  DbQueryInput,
  DbReadRowsInput,
} from '../../shared/databaseTypes';
import { IPC } from '../../shared/ipcChannels';
import type { DatabaseService } from '../database/service';
import { type DeployIpcRegistry, object, optionalText, serverId, text } from './deploy';

/**
 * The Database section's channels (E44). They answer only the main window, and every argument
 * is checked here, so nothing malformed reaches a driver or a server.
 */

/** Backups, run with the engines' own tools (see database/backup.ts). */
export interface DatabaseBackupHandlers {
  list: (connectionId: string) => Promise<unknown>;
  backup: (connectionId: string) => Promise<unknown>;
  restore: (connectionId: string, name: string) => Promise<void>;
  restoreFromFile: (connectionId: string) => Promise<boolean>;
  remove: (connectionId: string, name: string) => Promise<void>;
  reveal: (connectionId: string, name: string) => void;
}

export interface DatabaseHandlerDeps {
  ipc: DeployIpcRegistry;
  backups?: DatabaseBackupHandlers;
  service: Pick<
    DatabaseService,
    | 'listConnections'
    | 'saveConnection'
    | 'removeConnection'
    | 'discover'
    | 'connectCandidate'
    | 'connect'
    | 'disconnect'
    | 'listObjects'
    | 'describe'
    | 'readRows'
    | 'query'
    | 'cancelQuery'
    | 'settings'
    | 'users'
    | 'aiContext'
  >;
  guard: (event: IpcMainInvokeEvent) => boolean;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const KINDS: ReadonlySet<string> = new Set<DbObjectKind>([
  'database',
  'schema',
  'table',
  'view',
  'materializedView',
  'collection',
  'key',
]);
const MAX_NAME = 512;
const MAX_PASSWORD = 4096;
const MAX_QUERY = 1024 * 1024;
const MAX_FILTER = 8192;

function id(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`That is not a ${what}.`);
  return value;
}

function container(value: unknown): string {
  if (typeof value !== 'string' || !CONTAINER.test(value)) {
    throw new Error('That is not a container id or name.');
  }
  return value;
}

function nullableServer(value: unknown): string | null {
  return value === null || value === undefined ? null : serverId(value);
}

function password(value: unknown, what = 'password'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > MAX_PASSWORD) {
    throw new Error(`The ${what} must be text.`);
  }
  return value;
}

function port(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new Error('The port must be a number from 1 to 65535.');
  }
  return value as number;
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error('Expected yes or no.');
  return value;
}

function nullableText(value: unknown, what: string): string | null | undefined {
  if (value === null) return null;
  return optionalText(value, MAX_NAME, what);
}

function target(value: unknown): DatabaseTarget {
  const input = object(value, 'where the database is');
  switch (input.kind) {
    case 'direct':
      return {
        kind: 'direct',
        host: text(input.host, 253, 'host'),
        port: input.port === null ? null : port(input.port),
      };
    case 'server': {
      const containerId =
        input.containerId === undefined ? undefined : container(input.containerId);
      const containerName =
        input.containerName === undefined ? undefined : container(input.containerName);
      return {
        kind: 'server',
        serverId: serverId(input.serverId),
        host: text(input.host, 253, 'host'),
        port: port(input.port),
        ...(containerId ? { containerId } : {}),
        ...(containerName ? { containerName } : {}),
      };
    }
    case 'localContainer':
      return {
        kind: 'localContainer',
        containerId: container(input.containerId),
        containerName: container(input.containerName),
        port: port(input.port),
      };
    case 'sqliteFile':
      return { kind: 'sqliteFile', path: text(input.path, 4096, 'file path') };
    default:
      throw new Error('That is not a kind of database location.');
  }
}

function saveInput(value: unknown): DatabaseSaveInput {
  const input = object(value, 'a connection');
  if (!isDbEngine(input.engine)) throw new Error('That is not a database engine Runova knows.');
  const out: DatabaseSaveInput = {
    name: text(input.name, 200, 'name'),
    engine: input.engine,
    target: target(input.target),
  };
  if (input.id !== undefined) out.id = id(input.id, 'saved connection');
  const user = nullableText(input.user, 'user');
  if (user !== undefined) out.user = user;
  const database = nullableText(input.database, 'database');
  if (database !== undefined) out.database = database;
  const authDatabase = nullableText(input.authDatabase, 'auth database');
  if (authDatabase !== undefined) out.authDatabase = authDatabase;
  for (const key of ['tls', 'srv', 'readOnly'] as const) {
    const value = flag(input[key]);
    if (value !== undefined) out[key] = value;
  }
  const secret = password(input.password);
  if (secret !== undefined) out.password = secret;
  return out;
}

function candidateInput(value: unknown): DatabaseConnectCandidateInput {
  const input = object(value, 'a container');
  const out: DatabaseConnectCandidateInput = {
    serverId: nullableServer(input.serverId),
    containerId: container(input.containerId),
  };
  const account = password(input.password);
  if (account) out.password = account;
  const code = optionalText(input.totpCode, 16, 'authenticator code');
  if (code) out.totpCode = code;
  const secret = password(input.databasePassword, 'database password');
  if (secret !== undefined) out.databasePassword = secret;
  return out;
}

function ref(value: unknown): DbObjectRef {
  const input = object(value, 'a table');
  const out: DbObjectRef = { name: text(input.name, MAX_NAME, 'name') };
  const database = optionalText(input.database, MAX_NAME, 'database');
  if (database) out.database = database;
  const schema = optionalText(input.schema, MAX_NAME, 'schema');
  if (schema) out.schema = schema;
  return out;
}

function kind(value: unknown): DbObjectKind | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !KINDS.has(value))
    throw new Error('That is not a kind of object.');
  return value as DbObjectKind;
}

function whole(value: unknown, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`The ${what} must be a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

function listInput(value: unknown): DbListObjectsInput {
  const input = object(value, 'what to list');
  const out: DbListObjectsInput = {
    sessionId: id(input.sessionId, 'connection'),
    parent: input.parent === null || input.parent === undefined ? null : ref(input.parent),
    parentKind: kind(input.parentKind),
  };
  const search = optionalText(input.search, MAX_NAME, 'search');
  if (search) out.search = search;
  return out;
}

function rowsInput(value: unknown): DbReadRowsInput {
  const input = object(value, 'which rows');
  const out: DbReadRowsInput = {
    sessionId: id(input.sessionId, 'connection'),
    ref: ref(input.ref),
    limit: whole(input.limit, 1, 100_000, 'page size'),
    offset: whole(input.offset, 0, Number.MAX_SAFE_INTEGER, 'offset'),
  };
  if (input.filter !== undefined && input.filter !== '') {
    out.filter = text(input.filter, MAX_FILTER, 'filter');
  }
  if (input.orderBy !== undefined && input.orderBy !== null) {
    const order = object(input.orderBy, 'a sort');
    if (order.direction !== 'asc' && order.direction !== 'desc') {
      throw new Error('Sort up or down.');
    }
    out.orderBy = { column: text(order.column, MAX_NAME, 'column'), direction: order.direction };
  }
  return out;
}

function queryInput(value: unknown): DbQueryInput {
  const input = object(value, 'a query');
  if (typeof input.text !== 'string' || input.text.length > MAX_QUERY) {
    throw new Error('The query must be text of at most 1 MB.');
  }
  const out: DbQueryInput = {
    sessionId: id(input.sessionId, 'connection'),
    queryId: id(input.queryId, 'query id'),
    text: input.text,
  };
  if (input.database !== undefined) {
    out.database = input.database === null ? null : text(input.database, MAX_NAME, 'database');
  }
  if (input.maxRows !== undefined) out.maxRows = whole(input.maxRows, 1, 50_000, 'row cap');
  if (input.origin !== undefined) {
    if (input.origin !== 'editor' && input.origin !== 'ai')
      throw new Error('Unknown query origin.');
    out.origin = input.origin;
  }
  const confirmed = flag(input.confirmed);
  if (confirmed !== undefined) out.confirmed = confirmed;
  return out;
}

const BACKUP_NAME = /^[A-Za-z0-9._-]{1,200}$/;

function backupName(value: unknown): string {
  if (typeof value !== 'string' || !BACKUP_NAME.test(value) || value.startsWith('.')) {
    throw new Error('That is not a backup file.');
  }
  return value;
}

export function registerDatabaseHandlers({
  ipc,
  service,
  guard,
  backups,
}: DatabaseHandlerDeps): void {
  const handle = (channel: string, run: (...args: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!guard(event)) throw new Error('Databases are only available in the main window.');
      return run(...args);
    });
  };
  handle(IPC.database.listConnections, () => service.listConnections());
  handle(IPC.database.saveConnection, (value) => service.saveConnection(saveInput(value)));
  handle(IPC.database.removeConnection, (value) =>
    service.removeConnection(id(value, 'saved connection')),
  );
  handle(IPC.database.discover, (value) =>
    service.discover(nullableServer(object(value, 'where to look').serverId)),
  );
  handle(IPC.database.connectCandidate, (value) => service.connectCandidate(candidateInput(value)));
  handle(IPC.database.connect, (connectionId, secret) =>
    service.connect(id(connectionId, 'saved connection'), password(secret)),
  );
  handle(IPC.database.disconnect, (value) => service.disconnect(id(value, 'connection')));
  handle(IPC.database.listObjects, (value) => service.listObjects(listInput(value)));
  handle(IPC.database.describe, (sessionId, value) =>
    service.describe(id(sessionId, 'connection'), ref(value)),
  );
  handle(IPC.database.readRows, (value) => service.readRows(rowsInput(value)));
  handle(IPC.database.query, (value) => service.query(queryInput(value)));
  if (backups) {
    const connection = (value: unknown) => id(value, 'saved connection');
    handle(IPC.database.listBackups, (value) => backups.list(connection(value)));
    handle(IPC.database.backup, (value) => backups.backup(connection(value)));
    handle(IPC.database.restore, (value, name) =>
      backups.restore(connection(value), backupName(name)),
    );
    handle(IPC.database.restoreFromFile, (value) => backups.restoreFromFile(connection(value)));
    handle(IPC.database.removeBackup, (value, name) =>
      backups.remove(connection(value), backupName(name)),
    );
    handle(IPC.database.revealBackup, (value, name) =>
      backups.reveal(connection(value), backupName(name)),
    );
  }
  handle(IPC.database.aiContext, (value) => {
    const input = object(value, 'what the AI may see');
    return service.aiContext({
      sessionId: id(input.sessionId, 'connection'),
      ...(input.database === undefined || input.database === null
        ? {}
        : { database: text(input.database, MAX_NAME, 'database') }),
      includeSamples: input.includeSamples === true,
    });
  });
  handle(IPC.database.settings, (sessionId) => service.settings(id(sessionId, 'connection')));
  handle(IPC.database.users, (sessionId) => service.users(id(sessionId, 'connection')));
  handle(IPC.database.cancelQuery, (sessionId, queryId) =>
    service.cancelQuery(id(sessionId, 'connection'), id(queryId, 'query id')),
  );
}
