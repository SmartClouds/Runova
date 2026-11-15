import { type DbObjectRef, qualifiedName, quoteIdentifier } from './sqlBuild.js';
import type { DbEngine } from './types.js';

/**
 * Index and storage upkeep: what a measured fragmentation figure means for each engine, and the
 * statements that tidy it up. Every SQL engine names this differently (SQL Server rebuilds and
 * reorganizes, PostgreSQL reindexes and vacuums, MySQL optimizes, SQLite vacuums), so the rules
 * live here once and the UI only shows what the engine can do.
 */

/** What the user can ask for. "rebuild" is the engine's own heavy rebuild (REINDEX, OPTIMIZE). */
export type MaintenanceAction = 'rebuild' | 'reorganize' | 'statistics' | 'vacuum';

export type MaintenanceScope = 'index' | 'table' | 'heap' | 'database';

export type MaintenanceTarget =
  | { scope: 'index'; table: DbObjectRef; index: string }
  | { scope: 'table'; table: DbObjectRef }
  /** A SQL Server table with no clustered index. */
  | { scope: 'heap'; table: DbObjectRef }
  | { scope: 'database' };

export interface MaintenanceOptions {
  /** SQL Server: keep the table usable while it rebuilds (Enterprise, Developer and Azure). */
  online?: boolean;
  /** How full to pack each page, 1 to 100. */
  fillFactor?: number | null;
  /** SQL Server: sort in tempdb rather than in the user database. */
  sortInTempdb?: boolean;
  /** PostgreSQL: rebuild without blocking writes. */
  concurrently?: boolean;
}

/** The numbers one row of the health view carries. */
export interface FragmentationFacts {
  /**
   * SQL Server: logical fragmentation. PostgreSQL: bloat. MySQL, MariaDB and SQLite: the share of
   * the table or file that is free space.
   */
  fragmentationPercent: number | null;
  pageCount: number | null;
  sizeBytes: number | null;
}

export type AdviceSeverity = 'ok' | 'small' | 'warn' | 'bad' | 'unknown';

export interface MaintenanceAdvice {
  action: 'none' | 'reorganize' | 'rebuild';
  severity: AdviceSeverity;
  reason: string;
}

const MB = 1024 * 1024;

/** SQL Server ignores fragmentation in indexes smaller than this (Microsoft's guidance). */
export const MSSQL_MIN_PAGES = 1000;

function sizeLimit(engine: DbEngine): number {
  if (engine === 'postgres') return 8 * MB;
  if (engine === 'sqlite') return MB;
  return 10 * MB;
}

/** Whether a measured figure is worth acting on, and what to do about it. */
export function maintenanceAdvice(engine: DbEngine, facts: FragmentationFacts): MaintenanceAdvice {
  if (!['mssql', 'postgres', 'mysql', 'mariadb', 'sqlite'].includes(engine)) {
    return { action: 'none', severity: 'unknown', reason: 'Not measured.' };
  }
  // Size first: a tiny index needs nothing, measured or not.
  if (engine === 'mssql' && facts.pageCount !== null && facts.pageCount < MSSQL_MIN_PAGES) {
    return {
      action: 'none',
      severity: 'small',
      reason: 'Too small to matter (under 1,000 pages).',
    };
  }
  if (engine !== 'mssql' && facts.sizeBytes !== null && facts.sizeBytes < sizeLimit(engine)) {
    return {
      action: 'none',
      severity: 'small',
      reason: `Too small to matter (under ${sizeLimit(engine) / MB} MB).`,
    };
  }
  const percent = facts.fragmentationPercent;
  if (percent === null || !Number.isFinite(percent)) {
    return { action: 'none', severity: 'unknown', reason: 'Not measured.' };
  }
  const value = percent;

  if (engine === 'mssql') {
    if (value < 5) return { action: 'none', severity: 'ok', reason: 'Under 5%, nothing to do.' };
    if (value <= 30) {
      return {
        action: 'reorganize',
        severity: 'warn',
        reason: 'Between 5% and 30%: a reorganize is enough.',
      };
    }
    return { action: 'rebuild', severity: 'bad', reason: 'Over 30%: rebuild it.' };
  }

  if (engine === 'postgres') {
    if (value >= 30) return { action: 'rebuild', severity: 'bad', reason: '30% or more bloat.' };
    if (value >= 20) {
      return { action: 'none', severity: 'warn', reason: 'Some bloat. Worth watching.' };
    }
    return { action: 'none', severity: 'ok', reason: 'Little bloat.' };
  }

  // MySQL, MariaDB and SQLite: the share that is free space.
  if (value >= 10) {
    return {
      action: 'rebuild',
      severity: value >= 30 ? 'bad' : 'warn',
      reason: `${Math.round(value)}% is free space a rebuild gives back.`,
    };
  }
  return { action: 'none', severity: 'ok', reason: 'Little free space.' };
}

export interface MaintenanceActionInfo {
  action: MaintenanceAction;
  label: string;
  description: string;
}

const item = (
  label: string,
  description: string,
  action: MaintenanceAction,
): MaintenanceActionInfo => ({
  action,
  label,
  description,
});

/** What the engine can do to an index, a table or the whole database, in the order to show. */
export function maintenanceActions(
  engine: DbEngine,
  scope: MaintenanceScope,
): MaintenanceActionInfo[] {
  switch (engine) {
    case 'mssql':
      if (scope === 'heap') {
        return [item('Rebuild', 'Rewrites the heap and removes forwarded rows.', 'rebuild')];
      }
      if (scope === 'database') {
        return [item('Update statistics', 'Refreshes statistics on every table.', 'statistics')];
      }
      return [
        item('Reorganize', 'Light, always online, can be stopped at any time.', 'reorganize'),
        item('Rebuild', 'Builds the index again from scratch.', 'rebuild'),
        item('Update statistics', 'Refreshes what the planner knows.', 'statistics'),
      ];
    case 'postgres':
      if (scope === 'index') {
        return [item('Reindex', 'Builds the index again and drops its bloat.', 'rebuild')];
      }
      if (scope === 'table') {
        return [
          item('Vacuum', 'Frees dead rows for reuse and refreshes statistics.', 'vacuum'),
          item('Reindex', 'Builds every index of the table again.', 'rebuild'),
          item('Analyze', 'Refreshes what the planner knows.', 'statistics'),
        ];
      }
      if (scope === 'database') {
        return [
          item('Vacuum', 'Vacuums and analyzes every table.', 'vacuum'),
          item('Analyze', 'Refreshes statistics on every table.', 'statistics'),
        ];
      }
      return [];
    case 'mysql':
    case 'mariadb':
      if (scope !== 'table') return [];
      return [
        item('Optimize', 'Rebuilds the table and its indexes, giving back free space.', 'rebuild'),
        item('Analyze', 'Refreshes the index statistics.', 'statistics'),
      ];
    case 'sqlite':
      if (scope === 'index') return [item('Reindex', 'Builds the index again.', 'rebuild')];
      if (scope === 'table') {
        return [
          item('Reindex', 'Builds its indexes again.', 'rebuild'),
          item('Analyze', 'Refreshes what the planner knows.', 'statistics'),
        ];
      }
      if (scope === 'database') {
        return [
          item('Vacuum', 'Rewrites the file and gives free pages back.', 'vacuum'),
          item('Analyze', 'Refreshes what the planner knows.', 'statistics'),
        ];
      }
      return [];
    default:
      return [];
  }
}

/** Adds the extension that gives PostgreSQL exact index numbers (`pgstatindex`). */
export const PRECISE_STATS_STATEMENT = 'CREATE EXTENSION IF NOT EXISTS pgstattuple;';

function refuse(message: string): never {
  throw new Error(message);
}

function checkOptions(
  engine: DbEngine,
  action: MaintenanceAction,
  options: MaintenanceOptions,
): void {
  const { online, fillFactor, sortInTempdb, concurrently } = options;
  const has = (value: unknown) => value !== undefined && value !== null && value !== false;
  if (has(fillFactor)) {
    const value = fillFactor as number;
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      refuse('The fill factor must be a whole number from 1 to 100.');
    }
  }
  if ((has(online) || has(sortInTempdb)) && engine !== 'mssql') {
    refuse('Online rebuilds and sorting in tempdb are SQL Server options.');
  }
  if (has(concurrently) && engine !== 'postgres') {
    refuse('Rebuilding concurrently is a PostgreSQL option.');
  }
  const optioned = has(fillFactor) || has(online) || has(sortInTempdb) || has(concurrently);
  if (!optioned) return;
  if (action !== 'rebuild') refuse(`A ${actionWord(action)} takes no options.`);
  if (engine !== 'mssql' && engine !== 'postgres') refuse('This engine takes no rebuild options.');
}

function actionWord(action: MaintenanceAction): string {
  return action === 'statistics' ? 'statistics update' : action;
}

function unsupported(engine: DbEngine, action: MaintenanceAction, scope: MaintenanceScope): never {
  if ((engine === 'mysql' || engine === 'mariadb') && scope === 'index') {
    refuse('MySQL rebuilds indexes with their table. Optimize the table instead.');
  }
  refuse(
    `This engine has no ${actionWord(action)} for ${scope === 'database' ? 'a' : 'an'} ${scope}.`,
  );
}

/** The statements one maintenance action turns into. Throws when the engine cannot do it. */
export function maintenanceStatements(
  engine: DbEngine,
  action: MaintenanceAction,
  target: MaintenanceTarget,
  options: MaintenanceOptions = {},
): string[] {
  if (!maintenanceActions(engine, target.scope).some((one) => one.action === action)) {
    unsupported(engine, action, target.scope);
  }
  checkOptions(engine, action, options);
  const q = (name: string) => quoteIdentifier(engine, name);
  const table = target.scope === 'database' ? '' : qualifiedName(engine, target.table);

  switch (engine) {
    case 'mssql': {
      const withClause = () => {
        const parts: string[] = [];
        if (options.online) parts.push('ONLINE = ON');
        if (options.fillFactor) parts.push(`FILLFACTOR = ${options.fillFactor}`);
        if (options.sortInTempdb) parts.push('SORT_IN_TEMPDB = ON');
        return parts.length > 0 ? ` WITH (${parts.join(', ')})` : '';
      };
      if (target.scope === 'database') return ['EXEC sp_updatestats;'];
      if (target.scope === 'heap') {
        if (options.fillFactor || options.sortInTempdb) {
          refuse('A heap has no fill factor or tempdb sort. Only Online applies to it.');
        }
        return [`ALTER TABLE ${table} REBUILD${withClause()};`];
      }
      const on = target.scope === 'index' ? `${q(target.index)} ON ${table}` : `ALL ON ${table}`;
      if (action === 'statistics') {
        // UPDATE STATISTICS takes no database name; the run already switched to the database.
        const local = qualifiedName(engine, {
          schema: target.table.schema,
          name: target.table.name,
        });
        return [
          target.scope === 'index'
            ? `UPDATE STATISTICS ${local} ${q(target.index)};`
            : `UPDATE STATISTICS ${local};`,
        ];
      }
      if (action === 'reorganize') return [`ALTER INDEX ${on} REORGANIZE;`];
      return [`ALTER INDEX ${on} REBUILD${withClause()};`];
    }
    case 'postgres': {
      const concurrently = options.concurrently ? 'CONCURRENTLY ' : '';
      if (target.scope === 'database')
        return [action === 'vacuum' ? 'VACUUM (ANALYZE);' : 'ANALYZE;'];
      if (target.scope === 'index') {
        const name = [target.table.schema, target.index]
          .filter((part): part is string => Boolean(part))
          .map(q)
          .join('.');
        const statements = options.fillFactor
          ? [`ALTER INDEX ${name} SET (fillfactor = ${options.fillFactor});`]
          : [];
        return [...statements, `REINDEX INDEX ${concurrently}${name};`];
      }
      if (action === 'vacuum') return [`VACUUM (ANALYZE) ${table};`];
      if (action === 'statistics') return [`ANALYZE ${table};`];
      return [`REINDEX TABLE ${concurrently}${table};`];
    }
    case 'mysql':
    case 'mariadb':
      return [action === 'statistics' ? `ANALYZE TABLE ${table};` : `OPTIMIZE TABLE ${table};`];
    case 'sqlite':
      if (target.scope === 'database') return [action === 'vacuum' ? 'VACUUM;' : 'ANALYZE;'];
      if (target.scope === 'index') return [`REINDEX ${q(target.index)};`];
      return [action === 'statistics' ? `ANALYZE ${table};` : `REINDEX ${table};`];
    default:
      return unsupported(engine, action, target.scope);
  }
}
