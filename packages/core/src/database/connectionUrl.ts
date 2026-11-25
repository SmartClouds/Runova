import { engineInfo } from './engines.js';
import type { DbEngine, DbTlsMode, ParsedConnectionUrl } from './types.js';

const SCHEMES: Readonly<
  Record<string, { engine: Exclude<DbEngine, 'sqlite'>; tls?: true; srv?: true }>
> = {
  postgres: { engine: 'postgres' },
  postgresql: { engine: 'postgres' },
  mysql: { engine: 'mysql' },
  mariadb: { engine: 'mariadb' },
  mongodb: { engine: 'mongodb' },
  'mongodb+srv': { engine: 'mongodb', tls: true, srv: true },
  redis: { engine: 'redis' },
  rediss: { engine: 'redis', tls: true },
  valkey: { engine: 'redis' },
  cassandra: { engine: 'cassandra' },
  scylla: { engine: 'cassandra' },
  mssql: { engine: 'mssql' },
  sqlserver: { engine: 'mssql' },
};

const NOT_A_URL =
  'This is not a database URL. Paste one like postgres://user:password@host:5432/db.';

const TLS_PARAMS: ReadonlyArray<[string, RegExp]> = [
  ['sslmode', /^(require|verify-ca|verify-full)$/i],
  ['ssl', /^(true|1)$/i],
  ['tls', /^(true|1)$/i],
  ['encrypt', /^(true|1)$/i],
];

/** A query parameter by name, ignoring case, since SQL Server URLs often capitalize them. */
function param(params: URLSearchParams, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of params) if (key.toLowerCase() === wanted) return value;
  return null;
}

const TRUE = /^(true|1)$/i;

/**
 * How strictly the certificate is checked. Every TLS connection checks the chain and the host
 * name, as the engines' own clients do, unless the URL itself says otherwise: sslmode=require
 * (Postgres: encrypt, skip the check), Mongo's tlsInsecure / tlsAllowInvalidCertificates or SQL
 * Server's trustServerCertificate. Those are the only ways to get an unchecked connection.
 */
function tlsModeOf(params: URLSearchParams): DbTlsMode {
  const sslmode = param(params, 'sslmode')?.toLowerCase();
  if (sslmode === 'require') return 'require';
  if (sslmode === 'verify-ca') return 'verify-ca';
  if (sslmode === 'verify-full') return 'verify-full';
  const insecure = ['tlsInsecure', 'tlsAllowInvalidCertificates', 'trustServerCertificate'];
  if (insecure.some((name) => TRUE.test(param(params, name) ?? ''))) return 'require';
  if (TRUE.test(param(params, 'tlsAllowInvalidHostnames') ?? '')) return 'verify-ca';
  return 'verify-full';
}

/** Reads a pasted connection URL. Throws a message the user can act on when it cannot. */
export function parseConnectionUrl(input: string): ParsedConnectionUrl {
  const text = input.trim();
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (!match) throw new Error(NOT_A_URL);
  const scheme = (match[1] ?? '').toLowerCase();
  const rest = match[2] ?? '';

  if (scheme === 'sqlite' || scheme === 'sqlite3' || scheme === 'file') {
    if (!rest) throw new Error('Add the path to the SQLite file after sqlite://.');
    return { engine: 'sqlite', file: decodeURIComponent(rest) };
  }

  const known = SCHEMES[scheme];
  if (!known) throw new Error(NOT_A_URL);

  if (!rest || /^[/?#]/.test(rest) || /@(?:[:/?#]|$)/.test(rest)) {
    throw new Error('Add the host name to the URL.');
  }
  const portText = /^(?:[^@/]*@)?(?:\[[^\]]+\]|[^:/?#]+):(\d+)/.exec(rest)?.[1];
  let port: number | null = null;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('The port in the URL must be a number from 1 to 65535.');
    }
  } else if (!known.srv) {
    port = engineInfo(known.engine).defaultPort;
  }

  let url: URL;
  try {
    // The URL parser only knows the authority of "special" schemes, so lend it one.
    url = new URL(`http://${rest}`);
  } catch {
    throw new Error(NOT_A_URL);
  }

  const params = url.searchParams;
  const tls =
    known.tls === true || TLS_PARAMS.some(([key, pattern]) => pattern.test(params.get(key) ?? ''));
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined;
  const parsed: ParsedConnectionUrl = {
    engine: known.engine,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    tls,
  };
  if (tls) parsed.tlsMode = tlsModeOf(params);
  if (url.username) parsed.user = decodeURIComponent(url.username);
  if (url.password) parsed.password = decodeURIComponent(url.password);
  if (database) parsed.database = database;
  const authSource = params.get('authSource');
  if (authSource) parsed.authDatabase = authSource;
  if (known.srv) parsed.srv = true;
  return orderKeys(parsed);
}

/** Keeps the key order stable, which keeps saved connections and test output easy to read. */
function orderKeys(parsed: Extract<ParsedConnectionUrl, { host: string }>): ParsedConnectionUrl {
  const { engine, host, port, user, password, database, authDatabase, srv, tls, tlsMode } = parsed;
  const out: Record<string, unknown> = { engine, host, port };
  if (user !== undefined) out.user = user;
  if (password !== undefined) out.password = password;
  if (database !== undefined) out.database = database;
  if (authDatabase !== undefined) out.authDatabase = authDatabase;
  if (srv) out.srv = true;
  out.tls = tls;
  if (tls && tlsMode) out.tlsMode = tlsMode;
  return out as ParsedConnectionUrl;
}

/**
 * A host as it goes into a URL: an IPv6 address in brackets, and anything else with every
 * character that would end the host (/, ?, #, @, :) percent-encoded, so a host name can never
 * carry a path, options or a second address into the URL.
 */
export function urlHost(host: string): string {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (bare.includes(':') && /^[0-9A-Fa-f:.]+(%[A-Za-z0-9_.-]+)?$/.test(bare)) {
    return `[${bare.replace('%', '%25')}]`;
  }
  return encodeURIComponent(host);
}

/**
 * Writes a connection back as a URL. The password is left out unless `withPassword` asks for
 * it, which only an explicit reveal does; that URL also names the Mongo auth database, so it
 * can be pasted into an app as it is.
 */
export function formatConnectionUrl(
  connection: ParsedConnectionUrl,
  options: { withPassword?: boolean } = {},
): string {
  if (connection.engine === 'sqlite') return `sqlite://${connection.file}`;
  const scheme = connection.srv
    ? 'mongodb+srv'
    : connection.tls && connection.engine === 'redis'
      ? 'rediss'
      : connection.engine;
  const secret =
    options.withPassword && connection.password !== undefined
      ? `:${encodeURIComponent(connection.password)}`
      : '';
  const name = connection.user ? encodeURIComponent(connection.user) : '';
  const user = name || secret ? `${name}${secret}@` : '';
  const port = connection.port === null ? '' : `:${connection.port}`;
  const database = connection.database ? `/${encodeURIComponent(connection.database)}` : '';
  const auth =
    options.withPassword && connection.authDatabase
      ? `?authSource=${encodeURIComponent(connection.authDatabase)}`
      : '';
  return `${scheme}://${user}${urlHost(connection.host)}${port}${database}${auth}`;
}
