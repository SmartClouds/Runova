import {
  buildReadRows,
  limitStatement,
  qualifiedName,
  quoteIdentifier,
  splitStatements,
} from '@runova/core';
import mysql from 'mysql2/promise';
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

/** mysql2's column type codes, for the result header. */
const TYPE_NAMES = new Map<number, string>([
  [0, 'decimal'],
  [1, 'tinyint'],
  [2, 'smallint'],
  [3, 'int'],
  [4, 'float'],
  [5, 'double'],
  [7, 'timestamp'],
  [8, 'bigint'],
  [9, 'mediumint'],
  [10, 'date'],
  [11, 'time'],
  [12, 'datetime'],
  [13, 'year'],
  [15, 'varchar'],
  [16, 'bit'],
  [245, 'json'],
  [246, 'decimal'],
  [247, 'enum'],
  [248, 'set'],
  [252, 'blob'],
  [253, 'varchar'],
  [254, 'char'],
  [255, 'geometry'],
]);

const ACCESS_DENIED = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR']);

type Connection = mysql.Connection;

async function connect(options: DriverConnectOptions): Promise<Connection> {
  try {
    const connection = await mysql.createConnection({
      host: options.host,
      port: options.port ?? 3306,
      user: options.user,
      password: options.password,
      database: options.database || undefined,
      ssl: options.tls ? { rejectUnauthorized: false } : undefined,
      connectTimeout: options.connectTimeoutMs ?? 15_000,
      // Dates stay as the server wrote them, and big numbers as text, so nothing is rounded.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
    });
    connection.on('error', () => undefined);
    return connection;
  } catch (error) {
    throw new DriverError(
      describeError(error),
      ACCESS_DENIED.has((error as { code?: string }).code ?? ''),
    );
  }
}

function asResultSet(
  rows: unknown,
  fields: mysql.FieldPacket[] | undefined,
  statement: string,
  started: number,
  maxRows: number,
): DbResultSet {
  if (!Array.isArray(rows)) {
    const header = rows as mysql.ResultSetHeader;
    return {
      columns: [],
      rows: [],
      affectedRows: header?.affectedRows ?? null,
      truncated: false,
      durationMs: Date.now() - started,
      statement,
      notice: header?.info ? String(header.info) : null,
    };
  }
  const list = rows as unknown[][];
  return {
    columns: (fields ?? []).map((field) => ({
      name: field.name,
      type: TYPE_NAMES.get(field.columnType ?? field.type ?? -1) ?? null,
    })),
    rows: list.slice(0, maxRows).map((row) => row.map(toCell)),
    affectedRows: null,
    truncated: list.length > maxRows,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

export async function openMysql(options: DriverConnectOptions): Promise<DbDriver> {
  const engine = options.engine === 'mariadb' ? 'mariadb' : 'mysql';
  const connection = await connect(options);
  let current: string | null = options.database || null;

  const use = async (database?: string | null) => {
    if (!database || database === current) return;
    await connection.query(`USE ${quoteIdentifier(engine, database)}`);
    current = database;
  };

  const describeTable = async (ref: DbObjectRef): Promise<DbTableDescription> => {
    const database = ref.database ?? current;
    if (!database) throw new DriverError('Pick a database first.');
    const [tables] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_TYPE AS type, TABLE_ROWS AS estimate FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [database, ref.name],
    );
    const found = tables[0];
    if (!found) throw new DriverError(`There is no table ${database}.${ref.name}.`);
    const [columns] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey, EXTRA AS extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, ref.name],
    );
    const [stats] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
      [database, ref.name],
    );
    const indexes = new Map<string, DbIndex>();
    for (const row of stats) {
      const name = String(row.name);
      const index = indexes.get(name) ?? {
        name,
        columns: [],
        unique: Number(row.nonUnique) === 0,
        primary: name === 'PRIMARY',
      };
      index.columns.push(String(row.columnName));
      indexes.set(name, index);
    }
    const isView = String(found.type).toUpperCase().includes('VIEW');
    let definition: string | null = null;
    try {
      const [created] = await connection.query<mysql.RowDataPacket[]>(
        `SHOW CREATE ${isView ? 'VIEW' : 'TABLE'} ${qualifiedName(engine, { database, name: ref.name })}`,
      );
      const row = created[0] ?? {};
      definition = String(row['Create Table'] ?? row['Create View'] ?? '') || null;
    } catch {
      // Not allowed to see it; the columns are enough.
    }
    return {
      ref: { database, name: ref.name },
      kind: isView ? 'view' : 'table',
      columns: columns.map(
        (row): DbColumn => ({
          name: String(row.name),
          type: String(row.type),
          nullable: row.nullable === 'YES',
          defaultValue: row.defaultValue === null ? null : String(row.defaultValue),
          primaryKey: row.columnKey === 'PRI',
          generated: /auto_increment|generated/i.test(String(row.extra ?? '')),
        }),
      ),
      indexes: [...indexes.values()],
      rowEstimate: found.estimate === null ? null : Number(found.estimate),
      definition,
    };
  };

  /** Runs one statement, giving every result set it returns (a CALL can return several). */
  const runOne = async (statement: string, maxRows: number): Promise<DbResultSet[]> => {
    const started = Date.now();
    const limited = limitStatement(engine, statement, maxRows + 1) ?? statement;
    const [rows, fields] = await connection.query({ sql: limited, rowsAsArray: true });
    // A statement that returned several result sets answers with a list of them.
    if (Array.isArray(fields) && Array.isArray(fields[0])) {
      return (rows as unknown[]).map((one, index) =>
        asResultSet(
          one,
          (fields as unknown as mysql.FieldPacket[][])[index],
          statement,
          started,
          maxRows,
        ),
      );
    }
    return [asResultSet(rows, fields, statement, started, maxRows)];
  };

  return {
    engine,

    async serverVersion() {
      const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
      return String(rows[0]?.version ?? '');
    },

    async listObjects(parent) {
      if (!parent) {
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
          'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
        );
        return rows.map(
          (row): DbObjectNode => ({
            kind: 'database',
            name: String(row.name),
            ref: { database: String(row.name), name: String(row.name) },
            hasChildren: true,
            rowEstimate: null,
          }),
        );
      }
      const database = parent.database ?? parent.name;
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estimate
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [database],
      );
      return rows.map(
        (row): DbObjectNode => ({
          kind: String(row.type).toUpperCase().includes('VIEW') ? 'view' : 'table',
          name: String(row.name),
          ref: { database, name: String(row.name) },
          hasChildren: false,
          rowEstimate: row.estimate === null ? null : Number(row.estimate),
        }),
      );
    },

    describe: describeTable,

    async readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage> {
      const table = await describeTable(input.ref);
      const ref = table.ref;
      const sql = buildReadRows(engine, ref, input);
      const started = Date.now();
      await connection.query('START TRANSACTION READ ONLY');
      try {
        const [rows, fields] = await connection.query({ sql, rowsAsArray: true });
        let total: number | null = null;
        if (countIsCheap(table.rowEstimate, input.filter)) {
          const where = input.filter?.trim() ? ` WHERE (${input.filter})` : '';
          const [count] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT COUNT(*) AS total FROM (SELECT 1 FROM ${qualifiedName(engine, ref)}${where} LIMIT ${EXACT_COUNT_LIMIT + 1}) AS t`,
          );
          const counted = Number(count[0]?.total);
          total = counted > EXACT_COUNT_LIMIT ? null : counted;
        }
        return {
          result: asResultSet(rows, fields, sql, started, input.limit),
          total,
          keyColumns: table.columns
            .filter((column) => column.primaryKey)
            .map((column) => column.name),
        };
      } finally {
        await connection.query('ROLLBACK').catch(() => undefined);
      }
    },

    async query(text: string, run: DriverQueryOptions): Promise<DriverQueryResult> {
      await use(run.database);
      const results: DbResultSet[] = [];
      const statements = splitStatements(engine, text);
      // KILL QUERY has to come from a second connection, since this one is busy.
      const onAbort = () => {
        void (async () => {
          const helper = await connect(options).catch(() => null);
          if (!helper) return;
          try {
            await helper.query(`KILL QUERY ${Number(connection.threadId)}`);
          } finally {
            await helper.end().catch(() => undefined);
          }
        })();
      };
      run.signal.addEventListener('abort', onAbort, { once: true });
      if (run.readOnly) await connection.query('SET SESSION TRANSACTION READ ONLY');
      try {
        for (const [index, statement] of statements.entries()) {
          if (run.signal.aborted) return { results, cancelled: true };
          try {
            results.push(...(await runOne(statement, run.maxRows)));
          } catch (error) {
            if (run.signal.aborted) return { results, cancelled: true };
            // A transaction the batch began must not stay open with half its changes in it.
            await connection.query('ROLLBACK').catch(() => undefined);
            return { results, error: { message: describeError(error), statementIndex: index } };
          }
          // USE inside the query moves the session; remember it so the next run starts there.
          const switched = /^\s*use\s+[`"]?([^`";\s]+)/i.exec(statement)?.[1];
          if (switched) current = switched;
        }
        return run.signal.aborted ? { results, cancelled: true } : { results };
      } finally {
        run.signal.removeEventListener('abort', onAbort);
        if (run.readOnly) {
          await connection.query('SET SESSION TRANSACTION READ WRITE').catch(() => undefined);
        }
      }
    },

    async settings(): Promise<DbSetting[]> {
      const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW GLOBAL VARIABLES');
      return rows.map((row) => ({
        name: String(row.Variable_name),
        value: String(row.Value ?? ''),
        unit: null,
        description: null,
        category: String(row.Variable_name).split('_')[0] ?? null,
        restartRequired: false,
        editable: true,
        options: null,
      }));
    },

    async users(): Promise<DbUser[]> {
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT User AS user, Host AS host, Super_priv AS super FROM mysql.user ORDER BY User, Host',
      );
      const users: DbUser[] = [];
      for (const row of rows) {
        const user = String(row.user);
        const host = String(row.host);
        let grants: string[] = [];
        try {
          const [shown] = await connection.query<mysql.RowDataPacket[]>('SHOW GRANTS FOR ?@?', [
            user,
            host,
          ]);
          grants = shown.map((one) => String(Object.values(one)[0] ?? ''));
        } catch {
          // Not allowed to see another user's grants; the name and host are still worth listing.
        }
        users.push({
          name: user,
          host,
          superuser: row.super === 'Y',
          canLogin: true,
          access: accessFromGrants(grants),
          detail: user.startsWith('mysql.') ? 'built in' : null,
        });
      }
      return users;
    },

    async close() {
      await connection.end().catch(() => connection.destroy());
    },
  };
}

/** "GRANT SELECT, INSERT ON `shop`.* TO ..." lines read as a level per database ("*" is all). */
export function accessFromGrants(grants: readonly string[]): DbUser['access'] {
  const levels = new Map<string, 'read' | 'write' | 'admin'>();
  const rank = { read: 1, write: 2, admin: 3 } as const;
  for (const grant of grants) {
    const match = /^GRANT (.+?) ON [`"]?([^`".]+|\*)[`"]?\.\* TO/i.exec(grant);
    if (!match) continue;
    const privileges = (match[1] ?? '').toUpperCase();
    const database = match[2] ?? '';
    const level = privileges.includes('ALL PRIVILEGES')
      ? 'admin'
      : /\b(INSERT|UPDATE|DELETE)\b/.test(privileges)
        ? 'write'
        : /\bSELECT\b/.test(privileges)
          ? 'read'
          : null;
    if (!level) continue;
    const current = levels.get(database);
    if (!current || rank[level] > rank[current]) levels.set(database, level);
  }
  return [...levels.entries()].map(([database, level]) => ({ database, level }));
}
