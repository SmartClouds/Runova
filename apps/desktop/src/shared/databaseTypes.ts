import type { AccessLevel, DbEngine, DbObjectRef, SchemaTable, StatementClass } from '@runova/core';

/**
 * Plain data the Database section passes between main and the renderer. Passwords go in once
 * (typed, or read from a container's environment or its project's .env in main) and stay sealed
 * in main. The one way back out is `revealSignIn`, which the user asks for by pressing Show and
 * which a server guards with a step-up.
 */

export type { DbObjectRef };

/** Where a database is, as main reaches it. */
export type DatabaseTarget =
  /** A host and port this computer reaches directly. */
  | { kind: 'direct'; host: string; port: number | null }
  /**
   * Somewhere a Deploy server reaches: a host and port seen from the server, carried over its SSH
   * connection. A container on the server names itself, so its address can be looked up again
   * when it moves.
   */
  | {
      kind: 'server';
      serverId: string;
      host: string;
      port: number;
      containerId?: string;
      containerName?: string;
    }
  /** A container in this computer's Docker. */
  | { kind: 'localContainer'; containerId: string; containerName: string; port: number }
  /** A SQLite file on this computer. */
  | { kind: 'sqliteFile'; path: string };

/** A saved connection, as the renderer sees it. */
export interface DatabaseConnection {
  id: string;
  name: string;
  engine: DbEngine;
  target: DatabaseTarget;
  user: string | null;
  database: string | null;
  /** Mongo: the database the user is defined in. */
  authDatabase: string | null;
  tls: boolean;
  /** Mongo: the host is a DNS seed list (mongodb+srv). */
  srv: boolean;
  /** Writes need a second confirmation, and the AI may never write. */
  readOnly: boolean;
  hasPassword: boolean;
  /** The password is sealed with a Servers passkey that is not unlocked yet. */
  locked: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A database container found on a server or on this computer, ready for one-click connect. */
export interface DatabaseCandidate {
  /** Stable across scans: "server:<serverId>:<containerName>" or "local:<containerName>". */
  key: string;
  source: 'server' | 'local';
  serverId: string | null;
  containerId: string;
  containerName: string;
  image: string;
  engine: DbEngine;
  running: boolean;
  /** The App Store app or compose project the container belongs to. */
  project: string | null;
  /** The saved connection already made from this container, if any. */
  connectionId: string | null;
}

export interface DatabaseDiscovery {
  candidates: DatabaseCandidate[];
  /** Why a source could not be read (no Docker here, the server not reachable). */
  problems: { source: 'server' | 'local'; message: string }[];
}

export interface DatabaseDiscoverInput {
  /** The server to scan, or null for this computer's Docker. */
  serverId: string | null;
}

export interface DatabaseConnectCandidateInput {
  serverId: string | null;
  containerId: string;
  /** A step-up for reading a server container's environment, when the core asked for one. */
  password?: string;
  totpCode?: string;
  /** The database's own password, when the environment did not have it. */
  databasePassword?: string;
}

/** Where a sign-in was written down: a container's environment or the project's .env. */
export interface DatabaseSignInOrigin {
  kind: 'container' | 'envFile' | 'app';
  /** The container name, or the path of the .env file. */
  where: string;
  /** The variable, such as POSTGRES_PASSWORD or DATABASE_URL_APP. */
  key: string;
}

/** One way to sign in to a database container, as the renderer sees it: no password. */
export interface DatabaseSignIn {
  /** Stable across scans, and carries no secret. */
  id: string;
  user: string | null;
  database: string | null;
  hasPassword: boolean;
  /** The account the container was started with. */
  owner: boolean;
  origin: DatabaseSignInOrigin;
  alsoIn: DatabaseSignInOrigin[];
  /** The saved connection already made from this sign-in, if any. */
  connectionId: string | null;
}

export interface DatabaseSignIns {
  signIns: DatabaseSignIn[];
  /** The project's .env Runova looked for, or null when the container is in no compose project. */
  envFile: { path: string; found: boolean } | null;
  /** Containers in the project whose environment could not be read. */
  unread: string[];
}

export interface DatabaseSignInInput extends DatabaseConnectCandidateInput {
  signInId: string;
}

/** A sign-in shown on purpose: the URL as the project's own containers would use it. */
export interface DatabaseRevealedSignIn {
  url: string;
  password: string | null;
}

export interface DatabaseSaveInput {
  /** Updates the connection with this id, or adds a new one. */
  id?: string;
  name: string;
  engine: DbEngine;
  target: DatabaseTarget;
  user?: string | null;
  database?: string | null;
  authDatabase?: string | null;
  tls?: boolean;
  srv?: boolean;
  readOnly?: boolean;
  /** A new password. Left out keeps the saved one; an empty string removes it. */
  password?: string;
}

/** An open connection. Every browse and query call names it. */
export interface DatabaseSession {
  sessionId: string;
  connection: DatabaseConnection;
  serverVersion: string;
}

/** What `connect` answers when a password is still needed. */
export interface DatabaseNeedsPassword {
  needsPassword: true;
  /** Why: none was found, or the one tried was refused. */
  reason: 'missing' | 'refused';
  engine: DbEngine;
  user: string | null;
}

export type DatabaseConnectResult = DatabaseSession | DatabaseNeedsPassword;

export type DbObjectKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'materializedView'
  | 'collection'
  | 'key';

/** One entry in the object tree. Children load when it opens. */
export interface DbObjectNode {
  kind: DbObjectKind;
  name: string;
  ref: DbObjectRef;
  /** Whether it can be opened to show more. */
  hasChildren: boolean;
  /** A count or an estimate, when the engine has one cheaply. */
  rowEstimate: number | null;
  /** Redis: the key's type. */
  detail?: string;
}

export interface DbListObjectsInput {
  sessionId: string;
  /** The node to open, or null for the top level. */
  parent: DbObjectRef | null;
  parentKind: DbObjectKind | null;
  /** Redis: a pattern to narrow the keys. */
  search?: string;
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  /** Auto increment, identity, serial. */
  generated: boolean;
}

export interface DbIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface DbTableDescription {
  ref: DbObjectRef;
  kind: DbObjectKind;
  columns: DbColumn[];
  indexes: DbIndex[];
  rowEstimate: number | null;
  /** The statement that would create it, when the engine can say. */
  definition: string | null;
}

/**
 * A cell as it travels to the renderer: plain JSON. Dates arrive as ISO text, big numbers and
 * binary as text, and documents or arrays as JSON values.
 */
export type DbCell = string | number | boolean | null | DbCell[] | { [key: string]: DbCell };

export interface DbResultSet {
  columns: { name: string; type: string | null }[];
  rows: DbCell[][];
  /** Rows changed by a write, when the engine says. */
  affectedRows: number | null;
  /** More rows exist than came back. */
  truncated: boolean;
  durationMs: number;
  /** The statement this result belongs to. */
  statement: string;
  /** A message the server sent along (a notice, a warning). */
  notice: string | null;
}

export interface DbQueryInput {
  sessionId: string;
  /** Lets `cancelQuery` stop this run. */
  queryId: string;
  text: string;
  /** The database the editor is pointed at, for engines that switch per query. */
  database?: string | null;
  /** The most rows any one result returns. */
  maxRows?: number;
  /**
   * Who wrote it. A query from the AI that is more than a read always waits for the user. One
   * typed in the editor waits only when it is destructive, or the connection is read-only.
   */
  origin?: 'editor' | 'ai';
  /** Set once the user confirmed. Without it, a held query comes back as `needsConfirmation`. */
  confirmed?: boolean;
}

export type DbQueryOutcome =
  | { status: 'done'; results: DbResultSet[] }
  | {
      status: 'failed';
      results: DbResultSet[];
      error: string;
      /** Which statement failed, counting from 0. */
      statementIndex: number | null;
    }
  | { status: 'needsConfirmation'; classification: StatementClass }
  | { status: 'cancelled'; results: DbResultSet[] };

export interface DbReadRowsInput {
  sessionId: string;
  ref: DbObjectRef;
  limit: number;
  offset: number;
  filter?: string;
  orderBy?: { column: string; direction: 'asc' | 'desc' };
}

export interface DbRowsPage {
  result: DbResultSet;
  /** The total, when it is cheap to count. */
  total: number | null;
  /** The columns that pick out one row, so rows can be edited. Empty when there are none. */
  keyColumns: string[];
}

/** One server setting, for the Settings tab. */
export interface DbSetting {
  name: string;
  value: string;
  unit: string | null;
  description: string | null;
  category: string | null;
  /** The server has to restart before a change counts. */
  restartRequired: boolean;
  /** Whether Runova can change it from here. */
  editable: boolean;
  /** The values it accepts, when the server lists them. */
  options: string[] | null;
}

/** One user (or role) and what it can reach, for the Users tab. */
export interface DbUser {
  name: string;
  /** MySQL and MariaDB: where the user may connect from. */
  host: string | null;
  superuser: boolean;
  canLogin: boolean;
  /** Access per database, when the engine can say it in these terms. */
  access: { database: string; level: AccessLevel }[] | null;
  /** Anything else worth showing: roles, flags. */
  detail: string | null;
}

/** A backup file kept for a connection. */
export interface DatabaseBackupFile {
  name: string;
  size: number;
  createdAt: number;
  /** False when the backup holds only part of the database (Cassandra keeps only the schema). */
  complete: boolean;
}

/** main -> renderer while a backup or restore streams. */
export interface DatabaseBackupProgress {
  connectionId: string;
  kind: 'backup' | 'restore';
  bytes: number;
  done: boolean;
}

/** What the AI is shown about a database: its tables and columns, and sample rows if allowed. */
export interface DbAiContext {
  database: string | null;
  schema: SchemaTable[];
  samples: { table: string; columns: string[]; rows: DbCell[][] }[];
}

export interface DbAiContextInput {
  sessionId: string;
  database?: string | null;
  /** Off unless the user turned "Let the AI see sample rows" on. */
  includeSamples: boolean;
}
