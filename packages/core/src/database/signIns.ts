import type { DotenvEntry } from '../env/dotenv.js';
import { parseConnectionUrl } from './connectionUrl.js';
import { credentialsFromEnv } from './detectContainer.js';
import type { DbCredentials, DbEngine } from './types.js';

/**
 * Every way to sign in to one database container that its project already writes down: the
 * owner the container was started with, the same names in the project's .env, and the
 * connection URLs the project's apps are given. Pure, so main can gather the inputs and the
 * rules stay testable.
 */

type Env = Readonly<Record<string, string | undefined>>;

export type SignInOriginKind = 'container' | 'envFile' | 'app';

/** Where a sign-in was read: a container's environment or the .env file, and the key. */
export interface SignInOrigin {
  kind: SignInOriginKind;
  /** The container name, or the path of the .env file. */
  where: string;
  key: string;
}

export interface FoundSignIn {
  /** Stable across scans and free of secrets: a hash of who, which database, and where from. */
  id: string;
  engine: DbEngine;
  user: string | null;
  password?: string;
  database: string | null;
  authDatabase?: string;
  /** The account the container was started with. Connect picks this one by default. */
  owner: boolean;
  origin: SignInOrigin;
  /** Other places the same sign-in was written down. */
  alsoIn: SignInOrigin[];
}

export interface SignInSources {
  engine: DbEngine;
  database: {
    /** The container name. */
    name: string;
    /** The compose service name, which other containers in the project use as the host. */
    service?: string | null;
    env: Env;
    /** Ports it listens on inside the container and on the host, for localhost URLs. */
    ports?: readonly number[];
  };
  envFile?: { path: string; entries: readonly DotenvEntry[] } | null;
  siblings?: readonly { name: string; env: Env }[];
}

/** The keys each engine's image reads its owner password from, in the order they win. */
const PASSWORD_KEYS: Readonly<Record<DbEngine, readonly string[]>> = {
  postgres: ['POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD'],
  mysql: ['MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD'],
  mariadb: ['MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MARIADB_PASSWORD', 'MYSQL_PASSWORD'],
  mongodb: ['MONGO_INITDB_ROOT_PASSWORD', 'MONGODB_ROOT_PASSWORD'],
  redis: ['REDIS_PASSWORD', 'REDISCLI_AUTH'],
  cassandra: ['CASSANDRA_PASSWORD'],
  mssql: ['MSSQL_SA_PASSWORD', 'SA_PASSWORD'],
  sqlite: [],
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

/** MySQL and MariaDB speak the same protocol, so a mysql:// URL signs in to either. */
function sameFamily(a: DbEngine, b: DbEngine): boolean {
  const family = (engine: DbEngine) => (engine === 'mariadb' ? 'mysql' : engine);
  return family(a) === family(b);
}

function passwordKey(engine: DbEngine, env: Env): string {
  return PASSWORD_KEYS[engine].find((key) => env[key] !== undefined && env[key] !== '') ?? '';
}

/** Two FNV-1a passes with different seeds, so ids stay short but rarely collide. */
function stableId(text: string): string {
  const pass = (seed: number) => {
    let hash = seed;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, '0');
  };
  return pass(0x811c9dc5) + pass(0x050c5d1f);
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) && !value.includes('${');
}

export function findSignIns(sources: SignInSources): FoundSignIn[] {
  const { engine, database } = sources;
  const hosts = new Set(
    [database.name, database.service].filter(Boolean).map((host) => String(host).toLowerCase()),
  );
  const ports = new Set(database.ports ?? []);
  const found: Omit<FoundSignIn, 'id' | 'alsoIn'>[] = [];

  const add = (credentials: DbCredentials, owner: boolean, origin: SignInOrigin) => {
    found.push({
      engine,
      user: credentials.user ?? null,
      ...(credentials.password !== undefined ? { password: credentials.password } : {}),
      database: credentials.database ?? null,
      ...(credentials.authDatabase ? { authDatabase: credentials.authDatabase } : {}),
      owner,
      origin,
    });
  };

  const fromUrl = (value: string, origin: SignInOrigin, local: boolean) => {
    if (!looksLikeUrl(value)) return;
    let parsed: ReturnType<typeof parseConnectionUrl>;
    try {
      parsed = parseConnectionUrl(value);
    } catch {
      return;
    }
    if (parsed.engine === 'sqlite' || !sameFamily(parsed.engine, engine)) return;
    const host = parsed.host.toLowerCase();
    const here =
      hosts.has(host) ||
      (local && LOCAL_HOSTS.has(host) && (parsed.port === null || ports.has(parsed.port)));
    if (!here) return;
    add(
      {
        ...(parsed.user !== undefined ? { user: parsed.user } : {}),
        ...(parsed.password !== undefined ? { password: parsed.password } : {}),
        ...(parsed.database !== undefined ? { database: parsed.database } : {}),
        ...(parsed.authDatabase !== undefined ? { authDatabase: parsed.authDatabase } : {}),
      },
      false,
      origin,
    );
  };

  // The owner, as the container was started.
  const owner = credentialsFromEnv(engine, database.env);
  add(owner, true, {
    kind: 'container',
    where: database.name,
    key: passwordKey(engine, database.env),
  });

  // The same names in the project's .env, which still has them when the container reads a file.
  const envFile = sources.envFile;
  if (envFile) {
    const record: Record<string, string> = {};
    for (const entry of envFile.entries) record[entry.key] = entry.value;
    const key = passwordKey(engine, record);
    // Names the .env leaves out are the ones the container was started with.
    if (key) {
      add(credentialsFromEnv(engine, { ...database.env, ...record }), true, {
        kind: 'envFile',
        where: envFile.path,
        key,
      });
    }
    for (const entry of envFile.entries) {
      fromUrl(entry.value, { kind: 'envFile', where: envFile.path, key: entry.key }, true);
    }
  }

  // The URLs the project's apps connect with.
  for (const sibling of sources.siblings ?? []) {
    if (sibling.name === database.name) continue;
    for (const [key, value] of Object.entries(sibling.env)) {
      if (value) fromUrl(value, { kind: 'app', where: sibling.name, key }, false);
    }
  }

  // An owner with no password is only worth keeping when nothing else knows that user's password.
  const merged = new Map<string, FoundSignIn>();
  for (const signIn of found) {
    const same = `${signIn.user ?? ''}\u0000${signIn.database ?? ''}\u0000${signIn.password ?? '\u0001'}`;
    const existing = merged.get(same);
    if (existing) {
      existing.alsoIn.push(signIn.origin);
      existing.owner ||= signIn.owner;
      continue;
    }
    const { origin } = signIn;
    merged.set(same, {
      ...signIn,
      id: stableId(
        [signIn.user ?? '', signIn.database ?? '', origin.kind, origin.where, origin.key].join(
          '\u0000',
        ),
      ),
      alsoIn: [],
    });
  }
  const list = [...merged.values()];
  const known = list.filter((one) => one.password !== undefined);
  const kept = list.filter(
    (one) =>
      one.password !== undefined ||
      !known.some((other) => other.user === one.user && other.database === one.database),
  );
  // Owners keep the order they were read in (the container before the .env); the rest by name.
  return kept.sort((a, b) => {
    if (a.owner || b.owner) return Number(b.owner) - Number(a.owner);
    return (
      (a.user ?? '').localeCompare(b.user ?? '') ||
      (a.database ?? '').localeCompare(b.database ?? '')
    );
  });
}
