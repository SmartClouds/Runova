import { buildReadRows, classifyStatement, splitStatements } from '@runova/core';
import { auth, Client, types } from 'cassandra-driver';
import type {
  DbColumn,
  DbIndex,
  DbObjectNode,
  DbObjectRef,
  DbReadRowsInput,
  DbResultSet,
  DbRowsPage,
  DbSetting,
  DbTableDescription,
  DbUser,
} from '../../../shared/databaseTypes';
import { toCell } from '../cells';
import { describeError } from './shared';
import {
  type DbDriver,
  type DriverConnectOptions,
  DriverError,
  type DriverQueryOptions,
  type DriverQueryResult,
} from './types';

/**
 * Cassandra (and Scylla) through the DataStax driver. Keyspaces hold tables; the schema comes
 * from system_schema. CQL has no OFFSET, so a later page is read through and cut, which is fine
 * for the first few thousand rows the grid shows.
 */

/** The local data center the official Cassandra and Scylla images start with. */
const DATA_CENTER = 'datacenter1';
/** How far into a table the grid pages before it asks for a filter instead. */
const MAX_OFFSET = 10_000;

/** Rows from the driver as grid rows, in the order of the result's columns. */
/** CQL type names by the driver's type codes, for the result header. */
const TYPE_NAMES = new Map<number, string>(
  Object.entries(types.dataTypes as unknown as Record<string, number>)
    .filter(([, code]) => typeof code === 'number')
    .map(([name, code]) => [code, name]),
);

export function cqlResult(
  columns: { name: string; type?: { code?: number } }[] | null | undefined,
  rows: Record<string, unknown>[] | undefined,
  statement: string,
  started: number,
  maxRows: number,
): DbResultSet {
  const list = columns ?? [];
  const data = rows ?? [];
  return {
    columns: list.map((column) => ({
      name: column.name,
      type: column.type?.code === undefined ? null : (TYPE_NAMES.get(column.type.code) ?? null),
    })),
    rows: data.slice(0, maxRows).map((row) => list.map((column) => toCell(row[column.name]))),
    affectedRows: null,
    truncated: data.length > maxRows,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

export async function openCassandra(options: DriverConnectOptions): Promise<DbDriver> {
  const client = new Client({
    contactPoints: [`${options.host}:${options.port ?? 9042}`],
    localDataCenter: DATA_CENTER,
    ...(options.database ? { keyspace: options.database } : {}),
    ...(options.user
      ? { authProvider: new auth.PlainTextAuthProvider(options.user, options.password ?? '') }
      : {}),
    ...(options.tls ? { sslOptions: { rejectUnauthorized: false } } : {}),
    socketOptions: { connectTimeout: options.connectTimeoutMs ?? 15_000, readTimeout: 0 },
    // Through a forward, the driver must keep to the one address it was given.
    policies: {},
    isMetadataSyncEnabled: false,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.shutdown().catch(() => undefined);
    const message = describeError(error);
    throw new DriverError(message, /authenticat|credentials|password/i.test(message));
  }
  let current = options.database ?? null;
  const execute = (text: string, params: unknown[] = [], fetchSize = 5000) =>
    client.execute(text, params, { prepare: params.length > 0, fetchSize });

  const describe = async (ref: DbObjectRef): Promise<DbTableDescription> => {
    const keyspace = ref.database ?? current;
    if (!keyspace) throw new DriverError('Pick a keyspace first.');
    const columns = (
      await execute(
        'SELECT column_name, type, kind, position FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
        [keyspace, ref.name],
      )
    ).rows;
    if (columns.length === 0) throw new DriverError(`There is no table ${keyspace}.${ref.name}.`);
    const order = (kind: string) => (kind === 'partition_key' ? 0 : kind === 'clustering' ? 1 : 2);
    const sorted = [...columns].sort(
      (a, b) =>
        order(a.kind) - order(b.kind) ||
        Number(a.position) - Number(b.position) ||
        String(a.column_name).localeCompare(String(b.column_name)),
    );
    const indexRows = (
      await execute(
        'SELECT index_name, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?',
        [keyspace, ref.name],
      ).catch(() => ({ rows: [] as types.Row[] }))
    ).rows;
    const keys = sorted
      .filter((column) => column.kind !== 'regular')
      .map((column) => String(column.column_name));
    const indexes: DbIndex[] = [
      { name: 'PRIMARY KEY', columns: keys, unique: true, primary: true },
      ...indexRows.map((row) => ({
        name: String(row.index_name),
        columns: [String((row.options as Record<string, string> | undefined)?.target ?? '')],
        unique: false,
        primary: false,
      })),
    ];
    return {
      ref: { database: keyspace, name: ref.name },
      kind: 'table',
      columns: sorted.map(
        (column): DbColumn => ({
          name: String(column.column_name),
          type: `${column.type}${column.kind === 'partition_key' ? ' (partition key)' : column.kind === 'clustering' ? ' (clustering)' : ''}`,
          nullable: column.kind === 'regular',
          defaultValue: null,
          primaryKey: column.kind !== 'regular',
          generated: false,
        }),
      ),
      indexes,
      rowEstimate: null,
      definition: null,
    };
  };

  return {
    engine: 'cassandra',

    async serverVersion() {
      const row = (await execute('SELECT release_version FROM system.local')).rows[0];
      return String(row?.release_version ?? '');
    },

    async listObjects(parent) {
      if (!parent) {
        const rows = (await execute('SELECT keyspace_name FROM system_schema.keyspaces')).rows;
        return rows
          .map((row) => String(row.keyspace_name))
          .sort(
            (a, b) =>
              Number(a.startsWith('system')) - Number(b.startsWith('system')) || a.localeCompare(b),
          )
          .map(
            (name): DbObjectNode => ({
              kind: 'database',
              name,
              ref: { database: name, name },
              hasChildren: true,
              rowEstimate: null,
            }),
          );
      }
      const keyspace = parent.database ?? parent.name;
      const tables = (
        await execute('SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [
          keyspace,
        ])
      ).rows;
      const views = (
        await execute('SELECT view_name FROM system_schema.views WHERE keyspace_name = ?', [
          keyspace,
        ]).catch(() => ({
          rows: [] as types.Row[],
        }))
      ).rows;
      return [
        ...tables.map((row) => ({ name: String(row.table_name), kind: 'table' as const })),
        ...views.map((row) => ({ name: String(row.view_name), kind: 'materializedView' as const })),
      ]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (entry): DbObjectNode => ({
            kind: entry.kind,
            name: entry.name,
            ref: { database: keyspace, name: entry.name },
            hasChildren: false,
            rowEstimate: null,
          }),
        );
    },

    describe,

    async readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage> {
      const table = await describe(input.ref);
      const offset = Math.min(input.offset, MAX_OFFSET);
      const text = buildReadRows('cassandra', table.ref, {
        ...input,
        limit: offset + input.limit,
        offset: 0,
      });
      const started = Date.now();
      const result = await execute(text, [], offset + input.limit);
      const page = cqlResult(result.columns, result.rows.slice(offset), text, started, input.limit);
      return {
        result: page,
        total: null,
        keyColumns: table.columns.filter((c) => c.primaryKey).map((c) => c.name),
      };
    },

    async query(text: string, run: DriverQueryOptions): Promise<DriverQueryResult> {
      if (run.database) current = run.database;
      const results: DbResultSet[] = [];
      for (const [index, statement] of splitStatements('cassandra', text).entries()) {
        if (run.signal.aborted) return { results, cancelled: true };
        const started = Date.now();
        try {
          if (run.readOnly && classifyStatement('cassandra', statement).kind !== 'read') {
            throw new Error('That statement changes the database, and this run is read-only.');
          }
          const use = /^\s*use\s+"?([^";\s]+)"?/i.exec(statement)?.[1];
          if (use) {
            await execute(`USE "${use.replaceAll('"', '""')}"`);
            current = use;
            results.push(cqlResult([], [], statement, started, run.maxRows));
            continue;
          }
          if (current && !use) await execute(`USE "${current.replaceAll('"', '""')}"`);
          const result = await execute(statement, [], run.maxRows + 1);
          results.push(cqlResult(result.columns, result.rows, statement, started, run.maxRows));
        } catch (error) {
          if (run.signal.aborted) return { results, cancelled: true };
          return { results, error: { message: describeError(error), statementIndex: index } };
        }
      }
      return { results };
    },

    async settings(): Promise<DbSetting[]> {
      const rows = (
        await execute('SELECT name, value FROM system_views.settings').catch(() => ({
          rows: [] as types.Row[],
        }))
      ).rows;
      return rows.map((row) => ({
        name: String(row.name),
        value: String(row.value ?? ''),
        unit: null,
        description: null,
        category: null,
        restartRequired: true,
        editable: false,
        options: null,
      }));
    },

    async users(): Promise<DbUser[]> {
      const roles = (
        await execute('SELECT role, is_superuser, can_login FROM system_auth.roles').catch(() => ({
          rows: [] as types.Row[],
        }))
      ).rows;
      const permissions = (
        await execute('SELECT role, resource, permissions FROM system_auth.role_permissions').catch(
          () => ({
            rows: [] as types.Row[],
          }),
        )
      ).rows;
      return roles.map((row) => {
        const name = String(row.role);
        const access = permissions
          .filter(
            (permission) =>
              permission.role === name && String(permission.resource).startsWith('data/'),
          )
          .map((permission) => {
            const granted = new Set((permission.permissions as string[] | null) ?? []);
            const database = String(permission.resource).split('/')[1] ?? '*';
            const level =
              granted.has('ALTER') || granted.has('DROP')
                ? 'admin'
                : granted.has('MODIFY')
                  ? 'write'
                  : 'read';
            return { database: database || '*', level: level as 'read' | 'write' | 'admin' };
          });
        return {
          name,
          host: null,
          superuser: row.is_superuser === true,
          canLogin: row.can_login === true,
          access,
          detail: null,
        };
      });
    },

    async close() {
      await client.shutdown().catch(() => undefined);
    },
  };
}
