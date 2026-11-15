import { quoteIdentifier, quoteLiteral } from '@runova/core';
import type {
  DbHealthReport,
  DbIndexHealth,
  DbIndexType,
  DbRelation,
  DbTableStorage,
} from '../../../shared/databaseTypes';
import { describeError } from './shared';
import { DriverError, type DriverSchemaGraph } from './types';

/**
 * SQL Server's diagram and health numbers. Fragmentation comes from
 * sys.dm_db_index_physical_stats: LIMITED reads only the levels above the leaves and is quick,
 * SAMPLED reads 1% of the leaf pages and is closer to the truth on big indexes. Every query
 * switches to the database first, so the catalog views and DMVs read that database.
 */

export type MssqlRows = (text: string) => Promise<Record<string, unknown>[]>;

const PAGE = 8192;
/** Enterprise and Developer (3), Azure SQL Database (5) and Managed Instance (8). */
const ONLINE_EDITIONS = new Set([3, 5, 8]);

const num = (value: unknown): number | null =>
  value === null || value === undefined || value === '' ? null : Number(value);

function scoped(database: string, schema: string | null, body: (filter: string) => string) {
  const filter = schema === null ? '' : ` AND s.name = ${quoteLiteral('mssql', schema)}`;
  return `USE ${quoteIdentifier('mssql', database)};\n${body(filter)}`;
}

function columnType(row: Record<string, unknown>): string {
  const type = String(row.type);
  const length = num(row.max_length) ?? 0;
  if (['varchar', 'char', 'varbinary', 'binary'].includes(type)) {
    return `${type}(${length === -1 ? 'max' : length})`;
  }
  if (['nvarchar', 'nchar'].includes(type)) return `${type}(${length === -1 ? 'max' : length / 2})`;
  if (['decimal', 'numeric'].includes(type)) return `${type}(${row.precision},${row.scale})`;
  return type;
}

const action = (value: unknown) => (value ? String(value).replaceAll('_', ' ') : null);

export async function mssqlSchemaGraph(
  rows: MssqlRows,
  database: string,
  schema: string | null,
): Promise<DriverSchemaGraph> {
  const [tables, columns, keys] = await Promise.all([
    rows(
      scoped(
        database,
        schema,
        (filter) => `SELECT s.name AS [schema], t.name AS name,
       (SELECT SUM(p.rows) FROM sys.partitions p
         WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS rows
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE t.is_ms_shipped = 0${filter}
 ORDER BY s.name, t.name`,
      ),
    ),
    rows(
      scoped(
        database,
        schema,
        (filter) => `SELECT s.name AS [schema], t.name AS [table], c.name AS name, ty.name AS type,
       c.max_length, c.precision, c.scale, c.is_nullable,
       CASE WHEN EXISTS (
         SELECT 1 FROM sys.index_columns ic
           JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
       ) THEN 1 ELSE 0 END AS pk
  FROM sys.columns c
  JOIN sys.tables t ON t.object_id = c.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.types ty ON ty.user_type_id = c.user_type_id
 WHERE t.is_ms_shipped = 0${filter}
 ORDER BY s.name, t.name, c.column_id`,
      ),
    ),
    rows(
      scoped(
        database,
        schema,
        (
          filter,
        ) => `SELECT fk.name, s.name AS from_schema, ft.name AS from_table, fc.name AS from_column,
       ts.name AS to_schema, tt.name AS to_table, tc.name AS to_column,
       fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
  JOIN sys.tables ft ON ft.object_id = fk.parent_object_id
  JOIN sys.schemas s ON s.schema_id = ft.schema_id
  JOIN sys.columns fc ON fc.object_id = fkc.parent_object_id AND fc.column_id = fkc.parent_column_id
  JOIN sys.tables tt ON tt.object_id = fk.referenced_object_id
  JOIN sys.schemas ts ON ts.schema_id = tt.schema_id
  JOIN sys.columns tc ON tc.object_id = fkc.referenced_object_id AND tc.column_id = fkc.referenced_column_id
 WHERE 1 = 1${filter}
 ORDER BY s.name, ft.name, fk.name, fkc.constraint_column_id`,
      ),
    ),
  ]);

  const byTable = new Map<string, DriverSchemaGraph['tables'][number]['columns']>();
  for (const row of columns) {
    const key = JSON.stringify([row.schema, row.table]);
    const list = byTable.get(key) ?? [];
    list.push({
      name: String(row.name),
      type: columnType(row),
      nullable: Boolean(row.is_nullable),
      primaryKey: Number(row.pk) === 1,
    });
    byTable.set(key, list);
  }
  const relations = new Map<string, DbRelation>();
  for (const row of keys) {
    const id = JSON.stringify([row.from_schema, row.name]);
    const relation = relations.get(id) ?? {
      name: String(row.name),
      from: {
        ref: { database, schema: String(row.from_schema), name: String(row.from_table) },
        columns: [],
      },
      to: {
        ref: { database, schema: String(row.to_schema), name: String(row.to_table) },
        columns: [],
      },
      onDelete: action(row.on_delete),
      onUpdate: action(row.on_update),
    };
    relation.from.columns.push(String(row.from_column));
    relation.to.columns.push(String(row.to_column));
    relations.set(id, relation);
  }
  return {
    database,
    schema,
    tables: tables.map((row) => ({
      ref: { database, schema: String(row.schema), name: String(row.name) },
      kind: 'table' as const,
      columns: byTable.get(JSON.stringify([row.schema, row.name])) ?? [],
      rowEstimate: num(row.rows),
    })),
    relations: [...relations.values()],
  };
}

function indexType(typeDesc: string): DbIndexType {
  switch (typeDesc.toUpperCase()) {
    case 'CLUSTERED':
      return 'clustered';
    case 'NONCLUSTERED':
      return 'nonclustered';
    case 'HEAP':
      return 'heap';
    case 'CLUSTERED COLUMNSTORE':
    case 'NONCLUSTERED COLUMNSTORE':
      return 'columnstore';
    case 'SPATIAL':
      return 'spatial';
    default:
      return 'other';
  }
}

function permissionProblem(error: unknown): boolean {
  const number = (error as { number?: number }).number;
  return number === 297 || number === 300 || /permission/i.test(describeError(error));
}

export async function mssqlHealth(
  rows: MssqlRows,
  database: string,
  schema: string | null,
  scan: 'fast' | 'thorough',
): Promise<DbHealthReport> {
  const mode = scan === 'thorough' ? 'SAMPLED' : 'LIMITED';
  const edition = num(
    (await rows("SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition"))[0]?.edition,
  );

  let physical: Record<string, unknown>[];
  try {
    // One row per index: partitions are added up, fragmentation weighted by their pages.
    physical = await rows(
      scoped(
        database,
        schema,
        (
          filter,
        ) => `SELECT s.name AS [schema], t.name AS [table], i.name AS name, i.index_id, i.type_desc,
       i.is_unique, i.is_primary_key,
       SUM(ps.avg_fragmentation_in_percent * ps.page_count) / NULLIF(SUM(ps.page_count), 0) AS frag,
       SUM(ps.page_count) AS pages
  FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, '${mode}') ps
  JOIN sys.indexes i ON i.object_id = ps.object_id AND i.index_id = ps.index_id
  JOIN sys.tables t ON t.object_id = i.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE ps.alloc_unit_type_desc = 'IN_ROW_DATA' AND ps.index_level = 0 AND t.is_ms_shipped = 0${filter}
 GROUP BY s.name, t.name, i.name, i.index_id, i.type_desc, i.is_unique, i.is_primary_key
 ORDER BY s.name, t.name, i.index_id`,
      ),
    );
  } catch (error) {
    if (permissionProblem(error)) {
      throw new DriverError(
        'Reading fragmentation needs the VIEW DATABASE STATE permission (VIEW DATABASE PERFORMANCE STATE on SQL Server 2022). Ask an administrator to grant it, or connect as one.',
      );
    }
    throw error;
  }

  const keyColumns = await rows(
    scoped(
      database,
      schema,
      (filter) => `SELECT ic.index_id, s.name AS [schema], t.name AS [table], c.name AS column_name
  FROM sys.index_columns ic
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  JOIN sys.tables t ON t.object_id = ic.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE ic.is_included_column = 0 AND ic.key_ordinal > 0 AND t.is_ms_shipped = 0${filter}
 ORDER BY s.name, t.name, ic.index_id, ic.key_ordinal`,
    ),
  );
  const columnsOf = new Map<string, string[]>();
  for (const row of keyColumns) {
    const key = JSON.stringify([row.schema, row.table, Number(row.index_id)]);
    columnsOf.set(key, [...(columnsOf.get(key) ?? []), String(row.column_name)]);
  }

  const indexes = physical.map((row): DbIndexHealth => {
    const pages = num(row.pages);
    const frag = num(row.frag);
    return {
      table: { database, schema: String(row.schema), name: String(row.table) },
      name: row.name === null || row.name === undefined ? null : String(row.name),
      type: indexType(String(row.type_desc ?? '')),
      columns: columnsOf.get(JSON.stringify([row.schema, row.table, Number(row.index_id)])) ?? [],
      unique: Boolean(row.is_unique),
      primary: Boolean(row.is_primary_key),
      sizeBytes: pages === null ? null : pages * PAGE,
      pageCount: pages,
      fragmentationPercent: frag === null ? null : Math.round(frag * 10) / 10,
    };
  });

  const storage = await rows(
    scoped(
      database,
      schema,
      (filter) => `SELECT s.name AS [schema], t.name AS [table],
       SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS rows,
       SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.used_page_count ELSE 0 END) * ${PAGE} AS data_bytes,
       SUM(CASE WHEN ps.index_id > 1 THEN ps.used_page_count ELSE 0 END) * ${PAGE} AS index_bytes,
       SUM(ps.reserved_page_count - ps.used_page_count) * ${PAGE} AS free_bytes
  FROM sys.dm_db_partition_stats ps
  JOIN sys.tables t ON t.object_id = ps.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE t.is_ms_shipped = 0${filter}
 GROUP BY s.name, t.name
 ORDER BY s.name, t.name`,
    ),
  );
  const tables = storage.map((row): DbTableStorage => {
    const data = num(row.data_bytes) ?? 0;
    const index = num(row.index_bytes) ?? 0;
    const free = num(row.free_bytes) ?? 0;
    const whole = data + index + free;
    return {
      table: { database, schema: String(row.schema), name: String(row.table) },
      rowEstimate: num(row.rows),
      dataBytes: data,
      indexBytes: index,
      freeBytes: free,
      freePercent: whole === 0 ? 0 : Math.round((free / whole) * 1000) / 10,
    };
  });

  const files = (
    await rows(
      `USE ${quoteIdentifier('mssql', database)};
SELECT SUM(CAST(size AS bigint)) * ${PAGE} AS size,
       SUM(CAST(size - FILEPROPERTY(name, 'SpaceUsed') AS bigint)) * ${PAGE} AS free
  FROM sys.database_files WHERE type = 0`,
    ).catch(() => [])
  )[0];

  return {
    database,
    measuredAt: new Date().toISOString(),
    method: `sys.dm_db_index_physical_stats, ${mode}`,
    precise: true,
    canBePrecise: false,
    onlineRebuild: edition !== null && ONLINE_EDITIONS.has(edition),
    indexes,
    tables,
    totalBytes: num(files?.size),
    freeBytes: num(files?.free),
    notes:
      scan === 'fast'
        ? ['A fast scan reads the upper index levels. A thorough scan samples the leaves too.']
        : [],
  };
}
