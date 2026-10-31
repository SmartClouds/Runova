import { buildReadRows, qualifiedName, quoteIdentifier, quoteLiteral } from '@runova/core';
import sql from 'mssql';
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
import { countIsCheap, describeError, EXACT_COUNT_LIMIT } from './shared';
import {
  type DbDriver,
  type DriverConnectOptions,
  DriverError,
  type DriverQueryOptions,
  type DriverQueryResult,
} from './types';

/**
 * SQL Server through the mssql package. A query runs batch by batch (split on GO lines), and a
 * read runs inside a transaction that is always rolled back, with SET ROWCOUNT capping what it
 * returns, so a write hidden in a read never lands.
 */

/** T-SQL batches, split on GO lines as sqlcmd does. Semicolons stay inside a batch. */
export function splitBatches(text: string): string[] {
  return text
    .split(/^[ \t]*go[ \t]*(?:\d+)?[ \t]*$/im)
    .map((batch) => batch.trim())
    .filter(Boolean);
}

/** A read wrapped so nothing it does is kept, and at most `rows` rows come back. */
export function readOnlyBatch(batch: string, rows: number): string {
  return `SET ROWCOUNT ${rows};\nBEGIN TRANSACTION;\n${batch}\n;IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\nSET ROWCOUNT 0;`;
}

type Recordset = sql.IRecordSet<unknown[]> & {
  columns: Record<string, { name: string; type?: { declaration?: string } }>;
};

function recordsetResult(
  recordset: Recordset,
  statement: string,
  started: number,
  maxRows: number,
): DbResultSet {
  const columns = Object.values(recordset.columns ?? {}).map((column) => ({
    name: column.name,
    type: column.type?.declaration ?? null,
  }));
  const rows = recordset as unknown as unknown[][];
  return {
    columns,
    rows: rows.slice(0, maxRows).map((row) => row.map(toCell)),
    affectedRows: null,
    truncated: rows.length > maxRows,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

export async function openMssql(options: DriverConnectOptions): Promise<DbDriver> {
  const pool = new sql.ConnectionPool({
    server: options.host,
    port: options.port ?? 1433,
    user: options.user,
    password: options.password,
    ...(options.database ? { database: options.database } : {}),
    connectionTimeout: options.connectTimeoutMs ?? 15_000,
    requestTimeout: 0,
    pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 },
    options: { encrypt: options.tls, trustServerCertificate: true, appName: 'Runova' },
  });
  pool.on('error', () => undefined);
  try {
    await pool.connect();
  } catch (error) {
    await pool.close().catch(() => undefined);
    const code = (error as { code?: string }).code;
    throw new DriverError(describeError(error), code === 'ELOGIN');
  }
  let current = options.database || 'master';
  const db = (name?: string | null) => quoteIdentifier('mssql', name || current);
  const rowsOf = async <T>(text: string): Promise<T[]> =>
    (await pool.request().query<T>(text)).recordset;

  const describe = async (ref: DbObjectRef): Promise<DbTableDescription> => {
    const database = ref.database ?? current;
    const schema = ref.schema ?? 'dbo';
    const where = `TABLE_SCHEMA = ${quoteLiteral('mssql', schema)} AND TABLE_NAME = ${quoteLiteral('mssql', ref.name)}`;
    const table = (
      await rowsOf<{ TABLE_TYPE: string }>(
        `SELECT TABLE_TYPE FROM ${db(database)}.INFORMATION_SCHEMA.TABLES WHERE ${where}`,
      )
    )[0];
    if (!table) throw new DriverError(`There is no table ${schema}.${ref.name}.`);
    const columns = await rowsOf<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      CHARACTER_MAXIMUM_LENGTH: number | null;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
      is_identity: boolean | null;
      is_pk: number;
    }>(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              COLUMNPROPERTY(OBJECT_ID(${quoteLiteral('mssql', `${database}.${schema}.${ref.name}`)}), c.COLUMN_NAME, 'IsIdentity') AS is_identity,
              CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS is_pk
         FROM ${db(database)}.INFORMATION_SCHEMA.COLUMNS c
         LEFT JOIN (
           SELECT ku.COLUMN_NAME FROM ${db(database)}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
             JOIN ${db(database)}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
               ON ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND ku.TABLE_SCHEMA = tc.TABLE_SCHEMA
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = ${quoteLiteral('mssql', schema)}
              AND tc.TABLE_NAME = ${quoteLiteral('mssql', ref.name)}
         ) k ON k.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.${where.replace(' AND TABLE_NAME', ' AND c.TABLE_NAME')}
        ORDER BY c.ORDINAL_POSITION`,
    );
    const indexRows = await rowsOf<{
      name: string;
      is_unique: boolean;
      is_primary_key: boolean;
      column_name: string;
    }>(
      `SELECT i.name, i.is_unique, i.is_primary_key, c.name AS column_name
         FROM ${db(database)}.sys.indexes i
         JOIN ${db(database)}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN ${db(database)}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         JOIN ${db(database)}.sys.tables t ON t.object_id = i.object_id
         JOIN ${db(database)}.sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = ${quoteLiteral('mssql', schema)} AND t.name = ${quoteLiteral('mssql', ref.name)} AND i.name IS NOT NULL
        ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal`,
    );
    const indexes = new Map<string, DbIndex>();
    for (const row of indexRows) {
      const index = indexes.get(row.name) ?? {
        name: row.name,
        columns: [],
        unique: row.is_unique,
        primary: row.is_primary_key,
      };
      index.columns.push(row.column_name);
      indexes.set(row.name, index);
    }
    const count = await rowsOf<{ rows: number }>(
      `SELECT SUM(p.rows) AS rows FROM ${db(database)}.sys.partitions p
         JOIN ${db(database)}.sys.tables t ON t.object_id = p.object_id
         JOIN ${db(database)}.sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = ${quoteLiteral('mssql', schema)} AND t.name = ${quoteLiteral('mssql', ref.name)} AND p.index_id IN (0, 1)`,
    ).catch(() => []);
    return {
      ref: { database, schema, name: ref.name },
      kind: table.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
      columns: columns.map(
        (column): DbColumn => ({
          name: column.COLUMN_NAME,
          type:
            column.CHARACTER_MAXIMUM_LENGTH === null
              ? column.DATA_TYPE
              : `${column.DATA_TYPE}(${column.CHARACTER_MAXIMUM_LENGTH === -1 ? 'max' : column.CHARACTER_MAXIMUM_LENGTH})`,
          nullable: column.IS_NULLABLE === 'YES',
          defaultValue: column.COLUMN_DEFAULT,
          primaryKey: column.is_pk === 1,
          generated: Boolean(column.is_identity),
        }),
      ),
      indexes: [...indexes.values()],
      rowEstimate:
        count[0]?.rows === undefined || count[0]?.rows === null ? null : Number(count[0].rows),
      definition: null,
    };
  };

  return {
    engine: 'mssql',

    async serverVersion() {
      const rows = await rowsOf<{ v: string }>(
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS v",
      );
      return rows[0]?.v ?? '';
    },

    async listObjects(parent, kind) {
      if (!parent) {
        return (
          await rowsOf<{ name: string }>(
            'SELECT name FROM sys.databases WHERE state = 0 ORDER BY name',
          )
        ).map(
          (row): DbObjectNode => ({
            kind: 'database',
            name: row.name,
            ref: { database: row.name, name: row.name },
            hasChildren: true,
            rowEstimate: null,
          }),
        );
      }
      const database = parent.database ?? parent.name;
      if (kind === 'database') {
        const rows = await rowsOf<{ name: string }>(
          `SELECT DISTINCT s.name FROM ${db(database)}.sys.schemas s
             LEFT JOIN ${db(database)}.sys.objects o ON o.schema_id = s.schema_id AND o.type IN ('U', 'V')
            WHERE o.object_id IS NOT NULL OR s.name = 'dbo'
            ORDER BY s.name`,
        );
        return rows.map(
          (row): DbObjectNode => ({
            kind: 'schema',
            name: row.name,
            ref: { database, schema: row.name, name: row.name },
            hasChildren: true,
            rowEstimate: null,
          }),
        );
      }
      const schema = parent.schema ?? parent.name;
      const rows = await rowsOf<{ name: string; type: string; rows: number | null }>(
        `SELECT o.name, RTRIM(o.type) AS type, p.rows
           FROM ${db(database)}.sys.objects o
           JOIN ${db(database)}.sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN (SELECT object_id, SUM(rows) AS rows FROM ${db(database)}.sys.partitions
                       WHERE index_id IN (0, 1) GROUP BY object_id) p ON p.object_id = o.object_id
          WHERE s.name = ${quoteLiteral('mssql', schema)} AND o.type IN ('U', 'V')
          ORDER BY o.name`,
      );
      return rows.map(
        (row): DbObjectNode => ({
          kind: row.type === 'V' ? 'view' : 'table',
          name: row.name,
          ref: { database, schema, name: row.name },
          hasChildren: false,
          rowEstimate: row.rows === null ? null : Number(row.rows),
        }),
      );
    },

    describe,

    async readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage> {
      const table = await describe(input.ref);
      const ref = table.ref;
      const text = buildReadRows('mssql', ref, input);
      const started = Date.now();
      const request = pool.request();
      request.arrayRowMode = true;
      const result = await request.query(readOnlyBatch(text, input.limit));
      let total: number | null = null;
      if (countIsCheap(table.rowEstimate, input.filter)) {
        const where = input.filter?.trim() ? ` WHERE (${input.filter})` : '';
        const counted = await rowsOf<{ total: number }>(
          readOnlyBatch(
            `SELECT COUNT(*) AS total FROM (SELECT TOP ${EXACT_COUNT_LIMIT + 1} 1 AS one FROM ${qualifiedName('mssql', ref)}${where}) AS t`,
            1,
          ),
        );
        const value = Number(counted[0]?.total);
        total = value > EXACT_COUNT_LIMIT ? null : value;
      }
      return {
        result: recordsetResult(
          result.recordset as unknown as Recordset,
          text,
          started,
          input.limit,
        ),
        total,
        keyColumns: table.columns
          .filter((column) => column.primaryKey)
          .map((column) => column.name),
      };
    },

    async query(text: string, run: DriverQueryOptions): Promise<DriverQueryResult> {
      if (run.database) current = run.database;
      const results: DbResultSet[] = [];
      for (const [index, batch] of splitBatches(text).entries()) {
        if (run.signal.aborted) return { results, cancelled: true };
        const started = Date.now();
        const request = pool.request();
        request.arrayRowMode = true;
        const onAbort = () => request.cancel();
        run.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const body = `USE ${db(current)};\n${batch}`;
          const result = await request.query(
            run.readOnly ? readOnlyBatch(body, run.maxRows + 1) : body,
          );
          const sets = (result.recordsets as unknown as Recordset[]) ?? [];
          for (const set of sets) results.push(recordsetResult(set, batch, started, run.maxRows));
          if (sets.length === 0) {
            const affected = (result.rowsAffected ?? []).reduce((sum, value) => sum + value, 0);
            results.push({
              columns: [],
              rows: [],
              affectedRows: affected,
              truncated: false,
              durationMs: Date.now() - started,
              statement: batch,
              notice: null,
            });
          }
        } catch (error) {
          if (run.signal.aborted) return { results, cancelled: true };
          await pool
            .request()
            .query('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION')
            .catch(() => undefined);
          return { results, error: { message: describeError(error), statementIndex: index } };
        } finally {
          run.signal.removeEventListener('abort', onAbort);
        }
      }
      return { results };
    },

    async settings(): Promise<DbSetting[]> {
      const rows = await rowsOf<{
        name: string;
        value_in_use: unknown;
        description: string;
        is_dynamic: boolean;
      }>(
        'SELECT name, value_in_use, description, is_dynamic FROM sys.configurations ORDER BY name',
      );
      return rows.map((row) => ({
        name: row.name,
        value: String(row.value_in_use ?? ''),
        unit: null,
        description: row.description,
        category: null,
        restartRequired: !row.is_dynamic,
        editable: true,
        options: null,
      }));
    },

    async users(): Promise<DbUser[]> {
      const rows = await rowsOf<{
        name: string;
        type_desc: string;
        is_disabled: boolean;
        sysadmin: number;
      }>(
        `SELECT name, type_desc, is_disabled, IS_SRVROLEMEMBER('sysadmin', name) AS sysadmin
           FROM sys.server_principals
          WHERE type IN ('S', 'U', 'G') AND name NOT LIKE '##%' ORDER BY name`,
      );
      return rows.map((row) => ({
        name: row.name,
        host: null,
        superuser: row.sysadmin === 1,
        canLogin: !row.is_disabled,
        access: null,
        detail: row.type_desc.replaceAll('_', ' ').toLowerCase(),
      }));
    },

    async close() {
      await pool.close().catch(() => undefined);
    },
  };
}
