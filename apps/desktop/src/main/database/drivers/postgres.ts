import { buildReadRows, limitStatement, qualifiedName, splitStatements } from '@runova/core';
import pg from 'pg';
import type {
  DbColumn,
  DbIndex,
  DbObjectKind,
  DbObjectNode,
  DbObjectRef,
  DbReadRowsInput,
  DbResultSet,
  DbRowsPage,
  DbTableDescription,
} from '../../../shared/databaseTypes';
import { toCell } from '../cells';
import { countIsCheap, describeError, EXACT_COUNT_LIMIT } from './shared';
import {
  type DbDriver,
  type DriverConnectOptions,
  DriverError,
  type DriverQueryOptions,
  type DriverQueryResult,
} from './types';

/** Types are read once per connection and reused, so result columns can say what they hold. */
const TYPE_NAMES = new Map<number, string>([
  [16, 'boolean'],
  [17, 'bytea'],
  [20, 'bigint'],
  [21, 'smallint'],
  [23, 'integer'],
  [25, 'text'],
  [114, 'json'],
  [700, 'real'],
  [701, 'double precision'],
  [1042, 'character'],
  [1043, 'varchar'],
  [1082, 'date'],
  [1083, 'time'],
  [1114, 'timestamp'],
  [1184, 'timestamptz'],
  [1700, 'numeric'],
  [2950, 'uuid'],
  [3802, 'jsonb'],
]);

const KIND_BY_RELKIND: Readonly<Record<string, DbObjectKind>> = {
  r: 'table',
  p: 'table',
  f: 'table',
  v: 'view',
  m: 'materializedView',
};

type Client = pg.Client;

function clientConfig(options: DriverConnectOptions, database: string): pg.ClientConfig {
  return {
    host: options.host,
    port: options.port ?? 5432,
    user: options.user,
    password: options.password,
    database,
    ssl: options.tls ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 15_000,
    application_name: 'Runova',
    // Numbers that do not fit a JS number arrive as text instead of rounded.
    types: {
      getTypeParser: (oid: number, format?: string) => {
        if (oid === 20 || oid === 1700) return (value: string) => value;
        return pg.types.getTypeParser(oid, format as 'text');
      },
    } as pg.CustomTypesConfig,
  };
}

async function connectClient(options: DriverConnectOptions, database: string): Promise<Client> {
  const client = new pg.Client(clientConfig(options, database));
  // An idle connection the server drops must not take the app down with an unhandled error.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    const code = (error as { code?: string }).code;
    throw new DriverError(describeError(error), code === '28P01' || code === '28000');
  }
  return client;
}

function resultSet(
  result: pg.QueryArrayResult,
  statement: string,
  started: number,
  maxRows: number,
): DbResultSet {
  const rows = result.rows ?? [];
  const truncated = rows.length > maxRows;
  const isRead =
    result.command === 'SELECT' || result.command === 'SHOW' || (result.fields?.length ?? 0) > 0;
  return {
    columns: (result.fields ?? []).map((field) => ({
      name: field.name,
      type: TYPE_NAMES.get(field.dataTypeID) ?? null,
    })),
    rows: rows.slice(0, maxRows).map((row) => row.map(toCell)),
    affectedRows: isRead ? null : (result.rowCount ?? null),
    truncated,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

export async function openPostgres(options: DriverConnectOptions): Promise<DbDriver> {
  const defaultDatabase = options.database || options.user || 'postgres';
  const clients = new Map<string, Promise<Client>>();
  const main = await connectClient(options, defaultDatabase);
  clients.set(defaultDatabase, Promise.resolve(main));

  /** Postgres connects to one database at a time, so each other one gets its own connection. */
  const clientFor = (database?: string | null): Promise<Client> => {
    const name = database || defaultDatabase;
    let client = clients.get(name);
    if (!client) {
      client = connectClient(options, name);
      client.catch(() => clients.delete(name));
      clients.set(name, client);
    }
    return client;
  };

  const cancel = async (client: Client) => {
    const pid = (client as unknown as { processID?: number }).processID;
    if (!pid) return;
    const helper = await connectClient(options, defaultDatabase).catch(() => null);
    if (!helper) return;
    try {
      await helper.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
      await helper.end().catch(() => undefined);
    }
  };

  const describeTable = async (ref: DbObjectRef): Promise<DbTableDescription> => {
    const client = await clientFor(ref.database);
    const schema = ref.schema ?? 'public';
    const relation = await client.query<{
      relkind: string;
      reltuples: number;
      definition: string | null;
    }>(
      `SELECT c.relkind, c.reltuples::float8 AS reltuples,
              CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS definition
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, ref.name],
    );
    const found = relation.rows[0];
    if (!found) throw new DriverError(`There is no table ${schema}.${ref.name}.`);
    const columns = await client.query<{
      name: string;
      type: string;
      nullable: boolean;
      default_value: string | null;
      generated: boolean;
      primary_key: boolean;
    }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default_value,
              (a.attidentity <> '' OR a.attgenerated <> ''
                OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%') AS generated,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary
                        AND a.attnum = ANY (i.indkey)) AS primary_key
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, ref.name],
    );
    const indexes = await client.query<{
      name: string;
      unique: boolean;
      primary: boolean;
      columns: string[];
    }>(
      `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
              array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index ix
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND t.relname = $2
        GROUP BY i.relname, ix.indisunique, ix.indisprimary
        ORDER BY ix.indisprimary DESC, i.relname`,
      [schema, ref.name],
    );
    return {
      ref: { database: ref.database ?? defaultDatabase, schema, name: ref.name },
      kind: KIND_BY_RELKIND[found.relkind] ?? 'table',
      columns: columns.rows.map(
        (row): DbColumn => ({
          name: row.name,
          type: row.type,
          nullable: row.nullable,
          defaultValue: row.default_value,
          primaryKey: row.primary_key,
          generated: row.generated,
        }),
      ),
      indexes: indexes.rows.map(
        (row): DbIndex => ({
          name: row.name,
          columns: row.columns,
          unique: row.unique,
          primary: row.primary,
        }),
      ),
      rowEstimate: found.reltuples >= 0 ? Math.round(found.reltuples) : null,
      definition: found.definition,
    };
  };

  return {
    engine: 'postgres',

    async serverVersion() {
      const result = await main.query<{ server_version: string }>('SHOW server_version');
      return result.rows[0]?.server_version ?? '';
    },

    async listObjects(parent, parentKind) {
      if (!parent) {
        const result = await main.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname',
        );
        return result.rows.map(
          (row): DbObjectNode => ({
            kind: 'database',
            name: row.datname,
            ref: { database: row.datname, name: row.datname },
            hasChildren: true,
            rowEstimate: null,
          }),
        );
      }
      const database = parent.database ?? parent.name;
      const client = await clientFor(database);
      if (parentKind === 'database') {
        const result = await client.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
            ORDER BY nspname = 'public' DESC, nspname`,
        );
        return result.rows.map(
          (row): DbObjectNode => ({
            kind: 'schema',
            name: row.nspname,
            ref: { database, schema: row.nspname, name: row.nspname },
            hasChildren: true,
            rowEstimate: null,
          }),
        );
      }
      if (parentKind === 'schema') {
        const schema = parent.schema ?? parent.name;
        const result = await client.query<{ relname: string; relkind: string; reltuples: number }>(
          `SELECT c.relname, c.relkind, c.reltuples::float8 AS reltuples
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition
            ORDER BY c.relname`,
          [schema],
        );
        return result.rows.map(
          (row): DbObjectNode => ({
            kind: KIND_BY_RELKIND[row.relkind] ?? 'table',
            name: row.relname,
            ref: { database, schema, name: row.relname },
            hasChildren: false,
            rowEstimate: row.reltuples >= 0 ? Math.round(row.reltuples) : null,
          }),
        );
      }
      return [];
    },

    describe: describeTable,

    async readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage> {
      const client = await clientFor(input.ref.database);
      const table = await describeTable(input.ref);
      const sql = buildReadRows('postgres', input.ref, input);
      const started = Date.now();
      await client.query('BEGIN READ ONLY');
      try {
        const result = await client.query({ text: sql, rowMode: 'array' });
        let total: number | null = null;
        if (countIsCheap(table.rowEstimate, input.filter)) {
          const where = input.filter?.trim() ? ` WHERE (${input.filter})` : '';
          const count = await client.query<{ count: string }>(
            `SELECT count(*) FROM (SELECT 1 FROM ${qualifiedName('postgres', input.ref)}${where} LIMIT ${EXACT_COUNT_LIMIT + 1}) AS t`,
          );
          const counted = Number(count.rows[0]?.count);
          total = counted > EXACT_COUNT_LIMIT ? null : counted;
        }
        return {
          result: resultSet(result, sql, started, input.limit),
          total,
          keyColumns: table.columns
            .filter((column) => column.primaryKey)
            .map((column) => column.name),
        };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    },

    async query(text: string, options: DriverQueryOptions): Promise<DriverQueryResult> {
      const client = await clientFor(options.database);
      const statements = splitStatements('postgres', text);
      const results: DbResultSet[] = [];
      const onAbort = () => void cancel(client);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.readOnly) await client.query('SET default_transaction_read_only = on');
      try {
        for (const [index, statement] of statements.entries()) {
          if (options.signal.aborted) return { results, cancelled: true };
          const started = Date.now();
          const limited = limitStatement('postgres', statement, options.maxRows + 1) ?? statement;
          try {
            const result = await client.query({ text: limited, rowMode: 'array' });
            const list = Array.isArray(result) ? (result as pg.QueryArrayResult[]) : [result];
            for (const one of list)
              results.push(resultSet(one, statement, started, options.maxRows));
          } catch (error) {
            // A transaction left aborted fails every later statement, and one the batch began must
            // not keep half its changes, so whatever is open is rolled back.
            await client.query('ROLLBACK').catch(() => undefined);
            if (options.signal.aborted) return { results, cancelled: true };
            return { results, error: { message: describeError(error), statementIndex: index } };
          }
        }
        return options.signal.aborted ? { results, cancelled: true } : { results };
      } finally {
        options.signal.removeEventListener('abort', onAbort);
        if (options.readOnly) {
          await client.query('SET default_transaction_read_only = off').catch(() => undefined);
        }
      }
    },

    async close() {
      const all = [...clients.values()];
      clients.clear();
      await Promise.all(
        all.map((client) => client.then((one) => one.end()).catch(() => undefined)),
      );
    },
  };
}
