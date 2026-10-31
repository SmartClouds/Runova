import { existsSync } from 'node:fs';
import { buildReadRows, limitStatement, qualifiedName, splitStatements } from '@runova/core';
import Database from 'better-sqlite3';
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
 * A SQLite file on this computer, opened with better-sqlite3. Reads run with query_only set, so a
 * write hidden in a read is refused. Queries run in this process, so a result is always capped.
 */

/** Settings worth seeing; SQLite has no server to configure. */
const PRAGMAS = [
  'journal_mode',
  'foreign_keys',
  'synchronous',
  'busy_timeout',
  'cache_size',
  'page_size',
  'page_count',
  'freelist_count',
  'auto_vacuum',
  'user_version',
  'encoding',
];

type Statement = {
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number };
  reader?: boolean;
  columns?: () => { name: string; type: string | null }[];
};

/** better-sqlite3 says whether a statement returns rows; the test stand-in does not. */
function returnsRows(statement: Statement, sql: string): boolean {
  if (typeof statement.reader === 'boolean') return statement.reader;
  return /^\s*(select|with|pragma|values|explain)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

function resultOf(
  records: Record<string, unknown>[],
  columns: { name: string; type: string | null }[] | null,
  statement: string,
  started: number,
  maxRows: number,
): DbResultSet {
  const names = columns?.map((column) => column.name) ?? Object.keys(records[0] ?? {});
  return {
    columns: (columns ?? names.map((name) => ({ name, type: null }))).map((column) => ({
      name: column.name,
      type: column.type ?? null,
    })),
    rows: records.slice(0, maxRows).map((record) => names.map((name) => toCell(record[name]))),
    affectedRows: null,
    truncated: records.length > maxRows,
    durationMs: Date.now() - started,
    statement,
    notice: null,
  };
}

export async function openSqlite(options: DriverConnectOptions): Promise<DbDriver> {
  const file = options.file;
  if (!file) throw new DriverError('Pick the SQLite file to open.');
  if (!existsSync(file)) throw new DriverError(`There is no file at ${file}.`);
  let db: Database.Database;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    throw new DriverError(describeError(error));
  }
  const prepare = (sql: string) => db.prepare(sql) as unknown as Statement;
  const all = <T>(sql: string, ...params: unknown[]) => prepare(sql).all(...params) as T[];

  const describe = async (ref: DbObjectRef): Promise<DbTableDescription> => {
    const master = all<{ type: string; sql: string | null }>(
      "SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
      ref.name,
    )[0];
    if (!master) throw new DriverError(`There is no table ${ref.name}.`);
    const info = all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(`PRAGMA table_info(${qualifiedName('sqlite', { name: ref.name })})`);
    const keys = info.filter((column) => column.pk > 0);
    const columns = info.map(
      (column): DbColumn => ({
        name: column.name,
        type: column.type || 'ANY',
        nullable: column.notnull === 0 && column.pk === 0,
        defaultValue: column.dflt_value,
        primaryKey: column.pk > 0,
        // An INTEGER PRIMARY KEY on its own is the rowid, which counts up by itself.
        generated: column.pk > 0 && keys.length === 1 && /^integer$/i.test(column.type),
      }),
    );
    const indexes: DbIndex[] = all<{ name: string; unique: number; origin: string }>(
      `PRAGMA index_list(${qualifiedName('sqlite', { name: ref.name })})`,
    ).map((index) => ({
      name: index.name,
      columns: all<{ name: string }>(
        `PRAGMA index_info(${qualifiedName('sqlite', { name: index.name })})`,
      ).map((column) => column.name),
      unique: index.unique === 1,
      primary: index.origin === 'pk',
    }));
    if (keys.length > 0 && !indexes.some((index) => index.primary)) {
      indexes.unshift({
        name: 'PRIMARY KEY',
        columns: keys.map((column) => column.name),
        unique: true,
        primary: true,
      });
    }
    let rowEstimate: number | null = null;
    if (master.type === 'table') {
      rowEstimate = Number(
        all<{ count: number }>(
          `SELECT count(*) AS count FROM ${qualifiedName('sqlite', { name: ref.name })}`,
        )[0]?.count ?? 0,
      );
    }
    return {
      ref: { name: ref.name },
      kind: master.type === 'view' ? 'view' : 'table',
      columns,
      indexes,
      rowEstimate,
      definition: master.sql,
    };
  };

  return {
    engine: 'sqlite',

    async serverVersion() {
      return String(
        all<{ version: string }>('SELECT sqlite_version() AS version')[0]?.version ?? '',
      );
    },

    async listObjects(parent) {
      if (parent) return [];
      return all<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      ).map(
        (row): DbObjectNode => ({
          kind: row.type === 'view' ? 'view' : 'table',
          name: row.name,
          ref: { name: row.name },
          hasChildren: false,
          rowEstimate: null,
        }),
      );
    },

    describe,

    async readRows(input: Omit<DbReadRowsInput, 'sessionId'>): Promise<DbRowsPage> {
      const table = await describe(input.ref);
      const ref = { name: input.ref.name };
      const sql = buildReadRows('sqlite', ref, input);
      const started = Date.now();
      db.pragma('query_only = ON');
      try {
        const statement = prepare(sql);
        const records = statement.all();
        let total: number | null = null;
        if (countIsCheap(table.rowEstimate, input.filter)) {
          const where = input.filter?.trim() ? ` WHERE (${input.filter})` : '';
          const count = Number(
            all<{ count: number }>(
              `SELECT count(*) AS count FROM (SELECT 1 FROM ${qualifiedName('sqlite', ref)}${where} LIMIT ${EXACT_COUNT_LIMIT + 1})`,
            )[0]?.count,
          );
          total = count > EXACT_COUNT_LIMIT ? null : count;
        }
        const columns =
          statement.columns?.() ??
          table.columns.map((column) => ({ name: column.name, type: column.type }));
        return {
          result: resultOf(records, columns, sql, started, input.limit),
          total,
          keyColumns: table.columns
            .filter((column) => column.primaryKey)
            .map((column) => column.name),
        };
      } finally {
        db.pragma('query_only = OFF');
      }
    },

    async query(text: string, run: DriverQueryOptions): Promise<DriverQueryResult> {
      const results: DbResultSet[] = [];
      if (run.readOnly) db.pragma('query_only = ON');
      try {
        for (const [index, statement] of splitStatements('sqlite', text).entries()) {
          if (run.signal.aborted) return { results, cancelled: true };
          const started = Date.now();
          try {
            const limited = limitStatement('sqlite', statement, run.maxRows + 1) ?? statement;
            const prepared = prepare(limited);
            if (returnsRows(prepared, limited)) {
              results.push(
                resultOf(
                  prepared.all(),
                  prepared.columns?.() ?? null,
                  statement,
                  started,
                  run.maxRows,
                ),
              );
            } else {
              const outcome = prepared.run();
              results.push({
                columns: [],
                rows: [],
                affectedRows: outcome.changes,
                truncated: false,
                durationMs: Date.now() - started,
                statement,
                notice: null,
              });
            }
          } catch (error) {
            // A transaction the batch began must not keep half its changes.
            try {
              db.exec('ROLLBACK');
            } catch {
              // No transaction was open.
            }
            return { results, error: { message: describeError(error), statementIndex: index } };
          }
        }
        return { results };
      } finally {
        if (run.readOnly) db.pragma('query_only = OFF');
      }
    },

    async settings(): Promise<DbSetting[]> {
      return PRAGMAS.map((name) => {
        let value = '';
        try {
          const row = all<Record<string, unknown>>(`PRAGMA ${name}`)[0];
          value = row ? String(Object.values(row)[0] ?? '') : '';
        } catch {
          // Not every build has every pragma.
        }
        return {
          name,
          value,
          unit: null,
          description: null,
          category: 'pragma',
          restartRequired: false,
          editable: false,
          options: null,
        };
      });
    },

    async close() {
      db.close();
    },
  };
}
