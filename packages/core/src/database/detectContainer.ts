import { engineInfo } from './engines.js';
import type { ContainerPortMapping, DbCredentials, DbEngine, DetectedDatabase } from './types.js';

/**
 * Image names, after the registry and tag are gone, that run each engine. A name matches when it
 * equals one of these or ends with "/" plus one, so "team/postgres" and "bitnami/postgresql" both
 * count. Admin tools (adminer, pgadmin, mongo-express) are not here, so they never match.
 */
const IMAGE_NAMES: ReadonlyArray<[DbEngine, readonly string[]]> = [
  [
    'postgres',
    ['postgres', 'postgresql', 'postgis', 'timescaledb', 'timescaledb-ha', 'supabase/postgres'],
  ],
  ['mariadb', ['mariadb']],
  ['mysql', ['mysql', 'mysql-server', 'percona-server', 'percona']],
  ['mongodb', ['mongo', 'mongodb', 'mongodb-community-server', 'mongodb-enterprise-server']],
  ['redis', ['redis', 'redis-stack', 'redis-stack-server', 'valkey', 'keydb']],
  ['cassandra', ['cassandra', 'scylla']],
  ['mssql', ['mssql/server', 'azure-sql-edge', 'mssql/rhel/server']],
];

/** "registry:5000/team/postgres:16@sha256:..." becomes "team/postgres". */
function repositoryPath(image: string): string {
  let rest = image.trim().toLowerCase();
  const at = rest.indexOf('@');
  if (at >= 0) rest = rest.slice(0, at);
  const parts = rest.split('/');
  const last = parts.length - 1;
  const colon = parts[last]?.indexOf(':') ?? -1;
  if (colon >= 0) parts[last] = parts[last]?.slice(0, colon) ?? '';
  // A first part with a dot or a port, or "localhost", is a registry host.
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    parts.shift();
  }
  if (parts[0] === 'library' && parts.length > 1) parts.shift();
  return parts.join('/');
}

/** Which engine an image runs, or null when it is not a database image Runova knows. */
export function engineFromImage(image: string): DbEngine | null {
  const path = repositoryPath(image);
  if (!path) return null;
  for (const [engine, names] of IMAGE_NAMES) {
    for (const name of names) {
      if (path === name || path.endsWith(`/${name}`)) return engine;
    }
  }
  return null;
}

type Env = Readonly<Record<string, string | undefined>>;

function first(env: Env, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function compact(credentials: DbCredentials): DbCredentials {
  const out: DbCredentials = {};
  for (const [key, value] of Object.entries(credentials) as [keyof DbCredentials, unknown][]) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function mysqlLike(env: Env, prefix: 'MYSQL' | 'MARIADB'): DbCredentials {
  const keys = (name: string) =>
    prefix === 'MARIADB' ? [`MARIADB_${name}`, `MYSQL_${name}`] : [`MYSQL_${name}`];
  const database = first(env, ...keys('DATABASE'));
  const rootPassword = first(env, ...keys('ROOT_PASSWORD'));
  if (rootPassword !== undefined)
    return compact({ user: 'root', password: rootPassword, database });
  const user = first(env, ...keys('USER'));
  const password = first(env, ...keys('PASSWORD'));
  if (user && password !== undefined) return compact({ user, password, database });
  const allowEmpty = first(
    env,
    ...keys('ALLOW_EMPTY_PASSWORD'),
    ...keys('ALLOW_EMPTY_ROOT_PASSWORD'),
  );
  if (allowEmpty && /^(1|yes|true)$/i.test(allowEmpty)) {
    return compact({ user: 'root', password: '', database });
  }
  return compact({ user: user ?? 'root', database });
}

/**
 * The sign-in a container was started with, read from the variables its image documents. Root or
 * superuser accounts come first, since managing a database needs them.
 */
export function credentialsFromEnv(engine: DbEngine, env: Env): DbCredentials {
  switch (engine) {
    case 'postgres': {
      const user = first(env, 'POSTGRES_USER', 'POSTGRESQL_USERNAME') ?? 'postgres';
      return compact({
        user,
        password: first(env, 'POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD'),
        database: first(env, 'POSTGRES_DB', 'POSTGRESQL_DATABASE') ?? user,
      });
    }
    case 'mysql':
      return mysqlLike(env, 'MYSQL');
    case 'mariadb':
      return mysqlLike(env, 'MARIADB');
    case 'mongodb': {
      const user = first(env, 'MONGO_INITDB_ROOT_USERNAME', 'MONGODB_ROOT_USER');
      const password = first(env, 'MONGO_INITDB_ROOT_PASSWORD', 'MONGODB_ROOT_PASSWORD');
      if (!user && !password) return {};
      return compact({ user: user ?? 'root', password, authDatabase: 'admin' });
    }
    case 'redis':
      return compact({ password: first(env, 'REDIS_PASSWORD', 'REDISCLI_AUTH') });
    case 'cassandra': {
      const password = first(env, 'CASSANDRA_PASSWORD');
      if (!password) return {};
      return compact({ user: first(env, 'CASSANDRA_USER') ?? 'cassandra', password });
    }
    case 'mssql':
      return compact({
        user: 'sa',
        password: first(env, 'MSSQL_SA_PASSWORD', 'SA_PASSWORD'),
        database: 'master',
      });
    case 'sqlite':
      return {};
  }
}

function listenPort(engine: DbEngine, env: Env): number {
  const fallback = engineInfo(engine).defaultPort ?? 0;
  const raw =
    engine === 'postgres'
      ? first(env, 'PGPORT', 'POSTGRESQL_PORT_NUMBER')
      : engine === 'mssql'
        ? first(env, 'MSSQL_TCP_PORT')
        : undefined;
  const port = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function passwordless(engine: DbEngine, env: Env): boolean {
  if (!engineInfo(engine).passwordRequired) return true;
  if (engine === 'postgres') {
    return (
      first(env, 'POSTGRES_HOST_AUTH_METHOD') === 'trust' ||
      first(env, 'ALLOW_EMPTY_PASSWORD') === 'yes'
    );
  }
  return false;
}

/**
 * Reads a running container as a database: its engine, the port it listens on, and the sign-in
 * from its environment. Answers null for a container that is not a database.
 */
export function detectContainer(container: {
  image: string;
  env?: Env;
  ports?: readonly ContainerPortMapping[];
}): DetectedDatabase | null {
  const engine = engineFromImage(container.image);
  if (!engine || engine === 'sqlite') return null;
  const env = container.env ?? {};
  const wanted = listenPort(engine, env);
  const ports = container.ports ?? [];
  const mapping =
    ports.find((port) => port.containerPort === wanted) ??
    (ports.length === 1 ? ports[0] : undefined);
  const credentials = credentialsFromEnv(engine, env);
  return {
    engine,
    containerPort: mapping?.containerPort ?? wanted,
    hostPort: mapping?.hostPort ?? null,
    credentials,
    needsPassword: credentials.password === undefined && !passwordless(engine, env),
  };
}
