import { maskedStatements, splitStatements } from './classify.js';
import type { DbEngine } from './types.js';

/** Where a table lives. Engines ignore the parts they do not have. */
export interface DbObjectRef {
  database?: string;
  schema?: string;
  name: string;
}

export interface ReadRowsOptions {
  limit: number;
  offset: number;
  /** A condition the user typed, without the WHERE. */
  filter?: string;
  orderBy?: { column: string; direction: 'asc' | 'desc' };
}

const MAX_PAGE = 100_000;

export function quoteIdentifier(engine: DbEngine, name: string): string {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      return `\`${name.replaceAll('`', '``')}\``;
    case 'mssql':
      return `[${name.replaceAll(']', ']]')}]`;
    default:
      return `"${name.replaceAll('"', '""')}"`;
  }
}

/**
 * A string as a literal, for the few statements that cannot take a parameter (a password in
 * CREATE ROLE, a setting) and for previews. Values in queries are bound as parameters instead.
 *
 * MySQL reads backslashes in strings as escapes, so they are doubled. PostgreSQL does too when
 * standard_conforming_strings is off, where 'a\' would end the string early, so text with a
 * backslash is written as E'...' with the backslashes doubled, which reads the same either way.
 */
export function quoteLiteral(engine: DbEngine, value: string): string {
  let text = value.replaceAll("'", "''");
  if (engine === 'mysql' || engine === 'mariadb') text = text.replaceAll('\\', '\\\\');
  if (engine === 'postgres' && text.includes('\\')) return `E'${text.replaceAll('\\', '\\\\')}'`;
  return engine === 'mssql' ? `N'${text}'` : `'${text}'`;
}

/** The table's name with the parts its engine needs to find it from any database. */
export function qualifiedName(engine: DbEngine, ref: DbObjectRef): string {
  const parts: string[] = [];
  if (engine === 'mysql' || engine === 'mariadb' || engine === 'cassandra' || engine === 'mssql') {
    if (ref.database) parts.push(ref.database);
  }
  if ((engine === 'postgres' || engine === 'mssql') && ref.schema) parts.push(ref.schema);
  parts.push(ref.name);
  return parts.map((part) => quoteIdentifier(engine, part)).join('.');
}

function wholeNumber(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`The ${label} must be a whole number from 0 to ${max}.`);
  }
  return value;
}

const ONE_CONDITION = "The filter must be one condition, like: total > 10 AND status = 'paid'.";

/**
 * The filter is a condition the user typed, so it is SQL on purpose, but it has to stay a
 * condition: one statement, and with its brackets balanced so it cannot close the WHERE (...)
 * it sits in and carry on with more of its own. Brackets inside strings, names and comments do
 * not count.
 */
function checkFilter(engine: DbEngine, filter: string): void {
  for (const statements of maskedStatements(engine, filter)) {
    if (statements.length > 1) throw new Error(ONE_CONDITION);
    let depth = 0;
    for (const ch of statements[0] ?? '') {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth < 0) throw new Error(`${ONE_CONDITION} It closes a bracket it did not open.`);
    }
    if (depth !== 0) throw new Error(`${ONE_CONDITION} A bracket in it is never closed.`);
  }
}

/**
 * The SELECT for one page of the data grid. `columns`, when given, are the table's columns, and
 * the sort has to name one of them.
 */
export function buildReadRows(
  engine: DbEngine,
  ref: DbObjectRef,
  options: ReadRowsOptions,
  columns?: readonly string[],
): string {
  const limit = wholeNumber(options.limit, 'page size', MAX_PAGE);
  const offset = wholeNumber(options.offset, 'offset', Number.MAX_SAFE_INTEGER);
  const filter = options.filter?.trim();
  if (filter) checkFilter(engine, filter);
  if (options.orderBy && columns && !columns.includes(options.orderBy.column)) {
    throw new Error(`There is no column ${options.orderBy.column} to sort by.`);
  }
  const table = qualifiedName(engine, ref);
  const order = options.orderBy
    ? `${quoteIdentifier(engine, options.orderBy.column)} ${options.orderBy.direction === 'desc' ? 'DESC' : 'ASC'}`
    : null;

  if (engine === 'cassandra') {
    const where = filter ? ` WHERE ${filter}` : '';
    return `SELECT * FROM ${table}${where} LIMIT ${limit}${filter ? ' ALLOW FILTERING' : ''}`;
  }
  const where = filter ? ` WHERE (${filter})` : '';
  if (engine === 'mssql') {
    return `SELECT * FROM ${table}${where} ORDER BY ${order ?? '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  return `SELECT * FROM ${table}${where}${order ? ` ORDER BY ${order}` : ''} LIMIT ${limit} OFFSET ${offset}`;
}

/**
 * A plain SELECT wrapped so the server sends at most `rows` rows, which keeps a query over a huge
 * table from filling the app's memory. Answers null when the statement cannot be wrapped (it is
 * not a SELECT, already has a LIMIT, locks rows, or the engine has no such subquery), and the
 * caller then caps the rows as they stream in instead.
 */
export function limitStatement(engine: DbEngine, statement: string, rows: number): string | null {
  if (engine !== 'postgres' && engine !== 'mysql' && engine !== 'mariadb' && engine !== 'sqlite') {
    return null;
  }
  const statements = splitStatements(engine, statement);
  if (statements.length !== 1) return null;
  const only = (statements[0] as string).replace(/;\s*$/, '');
  const lower = only.toLowerCase();
  if (!/^\s*(select|with)\b/.test(lower)) return null;
  if (/\b(limit|fetch|into|for\s+(update|share|no\s+key|key))\b/.test(lower)) return null;
  if (/\b(insert|update|delete|merge)\b/.test(lower)) return null;
  return `SELECT * FROM (${only}) AS runova_rows LIMIT ${wholeNumber(rows, 'row cap', MAX_PAGE + 1)}`;
}
