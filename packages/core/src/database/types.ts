/** The database engines the Database section can connect to. */
export type DbEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'mongodb'
  | 'redis'
  | 'sqlite'
  | 'cassandra'
  | 'mssql';

/** What a query is written in, which decides the editor, the classifier and the AI prompt. */
export type DbQueryLanguage = 'sql' | 'cql' | 'mongo' | 'redis';

/** The features an engine has, so the UI never shows a button that cannot work. */
export interface DbCapabilities {
  /** Databases (or keyspaces) inside one connection. */
  databases: boolean;
  /** Schemas inside a database (Postgres, SQL Server). */
  schemas: boolean;
  /** A table designer, or a collection designer for Mongo. */
  createTable: boolean;
  /** Editing rows in the data grid. */
  editRows: boolean;
  users: boolean;
  settings: boolean;
  backup: boolean;
  transactions: boolean;
}

export interface DbEngineInfo {
  engine: DbEngine;
  label: string;
  defaultPort: number | null;
  queryLanguage: DbQueryLanguage;
  /** The Monaco language id for the query editor. */
  editorLanguage: string;
  /** Whether the engine normally refuses a sign-in with no password. */
  passwordRequired: boolean;
  /** The word the UI uses for one table: "table", "collection" or "key". */
  objectNoun: string;
  sampleQuery: string;
  capabilities: DbCapabilities;
}

/** The sign-in a container's environment gives away. Every field is optional. */
export interface DbCredentials {
  user?: string;
  password?: string;
  database?: string;
  /** Mongo: the database the user is defined in. */
  authDatabase?: string;
}

/** A port a container exposes, and the port on its host it is published on, if any. */
export interface ContainerPortMapping {
  containerPort: number;
  hostPort: number | null;
}

export interface DetectedDatabase {
  engine: DbEngine;
  /** The port the engine listens on inside the container. */
  containerPort: number;
  /** Where that port is published on the host, or null when it is not. */
  hostPort: number | null;
  credentials: DbCredentials;
  /** True when the engine wants a password and the environment does not carry one. */
  needsPassword: boolean;
}

/** A connection read from a URL. A network address or a SQLite file. */
export type ParsedConnectionUrl =
  | {
      engine: Exclude<DbEngine, 'sqlite'>;
      host: string;
      /** Null only for a mongodb+srv host, whose ports come from DNS. */
      port: number | null;
      user?: string;
      password?: string;
      database?: string;
      authDatabase?: string;
      srv?: boolean;
      tls: boolean;
    }
  | { engine: 'sqlite'; file: string };

/** How serious a query is, which decides whether it can run without asking. */
export type StatementKind = 'read' | 'write' | 'ddl' | 'admin';

export interface StatementClass {
  kind: StatementKind;
  /** Drops, truncates, or changes every row: worth a second look before it runs. */
  destructive: boolean;
}
