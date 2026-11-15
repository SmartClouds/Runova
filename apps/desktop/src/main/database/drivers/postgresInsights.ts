import type {
  DbHealthReport,
  DbIndexHealth,
  DbIndexType,
  DbRelation,
  DbTableStorage,
} from '../../../shared/databaseTypes';
import { describeError } from './shared';
import type { DriverSchemaGraph } from './types';

/**
 * PostgreSQL's diagram and health numbers, each read in a few catalog queries for the whole
 * database (or one schema) rather than one per table.
 *
 * Index bloat is exact only with the pgstattuple extension (`pgstatindex`), which reads every
 * page of the index, so it runs on a thorough scan only. Otherwise it is estimated from the
 * planner's statistics: the pages the rows should need against the pages the index has.
 */

export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const USER_SCHEMAS = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`;
const IN_SCHEMA = '($1::text IS NULL OR n.nspname = $1)';

const ACTIONS: Readonly<Record<string, string>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

const num = (value: unknown): number | null =>
  value === null || value === undefined || value === '' ? null : Number(value);

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;

export async function pgSchemaGraph(
  client: PgQueryable,
  database: string,
  schema: string | null,
): Promise<DriverSchemaGraph> {
  const params = [schema];
  const [tables, columns, keys] = await Promise.all([
    client.query(
      `SELECT n.nspname AS schema, c.relname AS name, c.reltuples::float8 AS reltuples
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f') AND NOT c.relispartition AND ${USER_SCHEMAS} AND ${IN_SCHEMA}
        ORDER BY n.nspname, c.relname`,
      params,
    ),
    client.query(
      `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary
                        AND a.attnum = ANY (i.indkey)) AS primary_key
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f') AND NOT c.relispartition AND a.attnum > 0
          AND NOT a.attisdropped AND ${USER_SCHEMAS} AND ${IN_SCHEMA}
        ORDER BY n.nspname, c.relname, a.attnum`,
      params,
    ),
    client.query(
      `SELECT con.conname AS name, n.nspname AS from_schema, fc.relname AS from_table,
              tn.nspname AS to_schema, tc.relname AS to_table,
              ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS from_columns,
              ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS to_columns,
              con.confdeltype AS on_delete, con.confupdtype AS on_update
         FROM pg_constraint con
         JOIN pg_class fc ON fc.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = fc.relnamespace
         JOIN pg_class tc ON tc.oid = con.confrelid
         JOIN pg_namespace tn ON tn.oid = tc.relnamespace
        WHERE con.contype = 'f' AND ${USER_SCHEMAS} AND ${IN_SCHEMA}
        ORDER BY n.nspname, fc.relname, con.conname`,
      params,
    ),
  ]);

  const byTable = new Map<string, DriverSchemaGraph['tables'][number]['columns']>();
  for (const row of columns.rows) {
    const key = JSON.stringify([row.schema, row.table]);
    const list = byTable.get(key) ?? [];
    list.push({
      name: String(row.name),
      type: String(row.type),
      nullable: Boolean(row.nullable),
      primaryKey: Boolean(row.primary_key),
    });
    byTable.set(key, list);
  }
  return {
    database,
    schema,
    tables: tables.rows.map((row) => {
      const estimate = num(row.reltuples);
      return {
        ref: { database, schema: String(row.schema), name: String(row.name) },
        kind: 'table' as const,
        columns: byTable.get(JSON.stringify([row.schema, row.name])) ?? [],
        rowEstimate: estimate !== null && estimate >= 0 ? Math.round(estimate) : null,
      };
    }),
    relations: keys.rows.map(
      (row): DbRelation => ({
        name: String(row.name),
        from: {
          ref: { database, schema: String(row.from_schema), name: String(row.from_table) },
          columns: row.from_columns as string[],
        },
        to: {
          ref: { database, schema: String(row.to_schema), name: String(row.to_table) },
          columns: row.to_columns as string[],
        },
        onDelete: ACTIONS[String(row.on_delete)] ?? null,
        onUpdate: ACTIONS[String(row.on_update)] ?? null,
      }),
    ),
  };
}

const PAGE = 8192;
/** Page header and special space a B-tree leaf page cannot use. */
const PAGE_OVERHEAD = 24;
/** Index tuple header, before the key is padded to 8 bytes. */
const TUPLE_HEADER = 8;
/** The line pointer each tuple has in its page. */
const LINE_POINTER = 4;
/** The default B-tree fill factor. */
const FILL = 0.9;

/**
 * The share of a B-tree that is bloat, estimated from the rows it holds and their key width.
 * Null when the planner has no statistics for it yet.
 */
export function estimateBtreeBloat(input: {
  pages: number;
  tuples: number;
  keyWidth: number | null;
}): number | null {
  const { pages, tuples, keyWidth } = input;
  if (pages <= 0 || tuples < 0 || keyWidth === null) return null;
  const tupleBytes = Math.ceil((keyWidth + TUPLE_HEADER) / 8) * 8 + LINE_POINTER;
  const needed = Math.max(1, Math.ceil((tuples * tupleBytes) / ((PAGE - PAGE_OVERHEAD) * FILL)));
  return Math.max(0, Math.round(((pages - needed) / pages) * 1000) / 10);
}

const INDEX_TYPES = new Set<DbIndexType>(['btree', 'hash', 'gin', 'gist', 'brin', 'spgist']);

/** Exact bloat from pgstatindex: how far the leaves are below the 90% they are packed to. */
function leafBloat(density: number): number {
  return Math.max(0, Math.round(((FILL * 100 - density) / (FILL * 100)) * 1000) / 10);
}

export async function pgHealth(
  client: PgQueryable,
  database: string,
  schema: string | null,
  scan: 'fast' | 'thorough',
): Promise<DbHealthReport> {
  const params = [schema];
  const extension = (
    await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple') AS installed,
              EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgstattuple') AS available`,
    )
  ).rows[0];
  const installed = Boolean(extension?.installed);
  const available = Boolean(extension?.available);

  const indexRows = (
    await client.query(
      `SELECT i.oid, n.nspname AS schema, t.relname AS table, i.relname AS name, am.amname AS method,
              ix.indisunique AS unique, ix.indisprimary AS primary,
              ARRAY(SELECT coalesce(a.attname::text, '(expression)')
                      FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                      LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                     ORDER BY k.ord) AS columns,
              pg_relation_size(i.oid) AS size_bytes, i.relpages AS pages, i.reltuples::float8 AS tuples,
              (SELECT sum(s.avg_width) FROM unnest(ix.indkey) AS k(attnum)
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                 JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = t.relname
                                AND s.attname = a.attname) AS key_width
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_am am ON am.oid = i.relam
        WHERE ${USER_SCHEMAS} AND ${IN_SCHEMA}
        ORDER BY n.nspname, t.relname, i.relname`,
      params,
    )
  ).rows;

  const notes: string[] = [];
  const exact = installed && scan === 'thorough';
  let allExact = exact;
  const indexes: DbIndexHealth[] = [];
  for (const row of indexRows) {
    const method = String(row.method);
    const pages = num(row.pages) ?? 0;
    let fragmentation: number | null = null;
    if (method === 'btree') {
      fragmentation = estimateBtreeBloat({
        pages,
        tuples: num(row.tuples) ?? -1,
        keyWidth: num(row.key_width),
      });
      if (exact) {
        try {
          const stats = (
            await client.query('SELECT avg_leaf_density FROM pgstatindex($1::regclass)', [
              Number(row.oid),
            ])
          ).rows[0];
          const density = num(stats?.avg_leaf_density);
          // An empty index reports NaN density; it has nothing to tidy.
          if (density !== null && Number.isFinite(density)) fragmentation = leafBloat(density);
        } catch (error) {
          allExact = false;
          const message = `${String(row.name)}: ${describeError(error)}`;
          if (notes.length < 5) notes.push(`Estimated instead of measured. ${message}`);
        }
      }
    }
    indexes.push({
      table: { database, schema: String(row.schema), name: String(row.table) },
      name: String(row.name),
      type: INDEX_TYPES.has(method as DbIndexType) ? (method as DbIndexType) : 'other',
      columns: row.columns as string[],
      unique: Boolean(row.unique),
      primary: Boolean(row.primary),
      sizeBytes: num(row.size_bytes),
      pageCount: pages,
      fragmentationPercent: fragmentation,
    });
  }

  const tableRows = (
    await client.query(
      `SELECT n.nspname AS schema, c.relname AS table, c.reltuples::float8 AS reltuples,
              pg_table_size(c.oid) AS data_bytes, pg_indexes_size(c.oid) AS index_bytes,
              s.n_live_tup AS live, s.n_dead_tup AS dead,
              greatest(s.last_vacuum, s.last_autovacuum) AS last_vacuum,
              greatest(s.last_analyze, s.last_autoanalyze) AS last_analyze
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE c.relkind IN ('r', 'p', 'm') AND ${USER_SCHEMAS} AND ${IN_SCHEMA}
        ORDER BY n.nspname, c.relname`,
      params,
    )
  ).rows;
  const tables = tableRows.map((row): DbTableStorage => {
    const live = num(row.live) ?? 0;
    const dead = num(row.dead) ?? 0;
    const dataBytes = num(row.data_bytes);
    const share = live + dead > 0 ? dead / (live + dead) : 0;
    const estimate = num(row.reltuples);
    return {
      table: { database, schema: String(row.schema), name: String(row.table) },
      rowEstimate: estimate !== null && estimate >= 0 ? Math.round(estimate) : null,
      dataBytes,
      indexBytes: num(row.index_bytes),
      freeBytes: dataBytes === null ? null : Math.round(dataBytes * share),
      freePercent: Math.round(share * 1000) / 10,
      deadRows: num(row.dead),
      lastVacuum: iso(row.last_vacuum),
      lastAnalyze: iso(row.last_analyze),
    };
  });

  const size = (await client.query('SELECT pg_database_size(current_database()) AS size')).rows[0];
  if (installed && scan === 'fast') {
    notes.unshift('Bloat is estimated. A thorough scan reads it exactly with pgstattuple.');
  }
  return {
    database,
    measuredAt: new Date().toISOString(),
    method: allExact ? 'pgstattuple' : 'planner statistics (estimate)',
    precise: allExact,
    canBePrecise: !installed && available,
    onlineRebuild: false,
    indexes,
    tables,
    totalBytes: num(size?.size),
    freeBytes: null,
    notes,
  };
}
