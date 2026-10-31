import type { DbCapabilities, DbEngine, DbEngineInfo } from './types.js';

const ALL: DbCapabilities = {
  databases: true,
  schemas: false,
  createTable: true,
  editRows: true,
  users: true,
  settings: true,
  backup: true,
  transactions: true,
};

/** Every engine the Database section supports, in the order the UI lists them. */
export const DB_ENGINES: readonly DbEngineInfo[] = [
  {
    engine: 'postgres',
    label: 'PostgreSQL',
    defaultPort: 5432,
    queryLanguage: 'sql',
    editorLanguage: 'pgsql',
    passwordRequired: true,
    objectNoun: 'table',
    sampleQuery: 'SELECT * FROM information_schema.tables LIMIT 50;',
    capabilities: { ...ALL, schemas: true },
  },
  {
    engine: 'mysql',
    label: 'MySQL',
    defaultPort: 3306,
    queryLanguage: 'sql',
    editorLanguage: 'mysql',
    passwordRequired: true,
    objectNoun: 'table',
    sampleQuery: 'SHOW TABLES;',
    capabilities: ALL,
  },
  {
    engine: 'mariadb',
    label: 'MariaDB',
    defaultPort: 3306,
    queryLanguage: 'sql',
    editorLanguage: 'mysql',
    passwordRequired: true,
    objectNoun: 'table',
    sampleQuery: 'SHOW TABLES;',
    capabilities: ALL,
  },
  {
    engine: 'mongodb',
    label: 'MongoDB',
    defaultPort: 27017,
    queryLanguage: 'mongo',
    editorLanguage: 'javascript',
    passwordRequired: false,
    objectNoun: 'collection',
    sampleQuery: 'db.getCollectionNames()',
    capabilities: { ...ALL, transactions: false },
  },
  {
    engine: 'redis',
    label: 'Redis',
    defaultPort: 6379,
    queryLanguage: 'redis',
    editorLanguage: 'redis',
    passwordRequired: false,
    objectNoun: 'key',
    sampleQuery: 'SCAN 0 COUNT 100',
    capabilities: { ...ALL, createTable: false, transactions: false },
  },
  {
    engine: 'sqlite',
    label: 'SQLite',
    defaultPort: null,
    queryLanguage: 'sql',
    editorLanguage: 'sql',
    passwordRequired: false,
    objectNoun: 'table',
    sampleQuery: "SELECT name FROM sqlite_master WHERE type = 'table';",
    capabilities: { ...ALL, databases: false, users: false },
  },
  {
    engine: 'cassandra',
    label: 'Cassandra',
    defaultPort: 9042,
    queryLanguage: 'cql',
    editorLanguage: 'sql',
    passwordRequired: false,
    objectNoun: 'table',
    sampleQuery: 'SELECT keyspace_name, table_name FROM system_schema.tables;',
    capabilities: { ...ALL, transactions: false },
  },
  {
    engine: 'mssql',
    label: 'SQL Server',
    defaultPort: 1433,
    queryLanguage: 'sql',
    editorLanguage: 'sql',
    passwordRequired: true,
    objectNoun: 'table',
    sampleQuery: 'SELECT TOP 50 * FROM INFORMATION_SCHEMA.TABLES;',
    capabilities: { ...ALL, schemas: true },
  },
];

const BY_ENGINE = new Map(DB_ENGINES.map((info) => [info.engine, info]));

export function engineInfo(engine: DbEngine): DbEngineInfo {
  const info = BY_ENGINE.get(engine);
  if (!info) throw new Error(`Unknown database engine: ${engine}`);
  return info;
}

export function isDbEngine(value: unknown): value is DbEngine {
  return typeof value === 'string' && BY_ENGINE.has(value as DbEngine);
}
