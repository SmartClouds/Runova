import type { DbEngine } from '@runova/core';
import type {
  DbObjectKind,
  DbObjectNode,
  DbObjectRef,
  DbReadRowsInput,
  DbResultSet,
  DbRowsPage,
  DbTableDescription,
} from '../../../shared/databaseTypes';

/** What a driver needs to sign in. The host and port are where main reaches it (maybe a forward). */
export interface DriverConnectOptions {
  engine: DbEngine;
  host: string;
  port: number | null;
  /** SQLite: the file. */
  file?: string;
  user?: string;
  password?: string;
  database?: string;
  authDatabase?: string;
  tls: boolean;
  srv: boolean;
  /** How long to wait for the server to answer the sign-in. */
  connectTimeoutMs?: number;
}

export interface DriverQueryOptions {
  /** The database to run in, for engines that switch per query. */
  database?: string | null;
  maxRows: number;
  /**
   * Run so that nothing can change, where the engine can promise it (a read-only transaction).
   * Set for every query the classifier reads as a read, so a write hiding in a read is refused.
   */
  readOnly: boolean;
  signal: AbortSignal;
}

export interface DriverQueryResult {
  results: DbResultSet[];
  error?: { message: string; statementIndex: number | null };
  cancelled?: boolean;
}

/** One open connection to one database server. Every engine's adapter has this shape. */
export interface DbDriver {
  readonly engine: DbEngine;
  serverVersion(): Promise<string>;
  /** The children of a node in the object tree, or the top level for null. */
  listObjects(
    parent: DbObjectRef | null,
    parentKind: DbObjectKind | null,
    search?: string,
  ): Promise<DbObjectNode[]>;
  describe(ref: DbObjectRef): Promise<DbTableDescription>;
  readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage>;
  query(text: string, options: DriverQueryOptions): Promise<DriverQueryResult>;
  close(): Promise<void>;
}

export class DriverError extends Error {
  constructor(
    message: string,
    /** The server refused the user name or password. */
    readonly authFailed = false,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
