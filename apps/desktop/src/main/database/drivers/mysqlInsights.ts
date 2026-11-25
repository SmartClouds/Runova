import type {
  DbHealthReport,
  DbIndexHealth,
  DbIndexType,
  DbRelation,
  DbTableStorage,
} from '../../../shared/databaseTypes';
import type { DriverSchemaGraph } from './types';

/**
 * MySQL's and MariaDB's diagram and health numbers, from information_schema. Neither engine
 * measures fragmentation per index: the measure is the free space a table holds (DATA_FREE),
 * which OPTIMIZE TABLE gives back by rebuilding the table and all its indexes.
 */

export interface MysqlQueryable {
  query(sql: string): Promise<[unknown, unknown]>;
  /** A prepared statement the server binds the values into (see mysql.ts). */
  execute(sql: string, params: string[]): Promise<[unknown, unknown]>;
}

type Row = Record<string, unknown>;

async function rows(connection: MysqlQueryable, sql: string, params?: string[]): Promise<Row[]> {
  const [result] = params ? await connection.execute(sql, params) : await connection.query(sql);
  return result as Row[];
}

const num = (value: unknown): number | null =>
  value === null || value === undefined || value === '' ? null : Number(value);

export async function mysqlSchemaGraph(
  connection: MysqlQueryable,
  database: string,
): Promise<DriverSchemaGraph> {
  const params = [database];
  const tables = await rows(
    connection,
    `SELECT TABLE_NAME AS name, TABLE_ROWS AS \`rows\` FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    params,
  );
  const columns = await rows(
    connection,
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS name, COLUMN_TYPE AS type,
            IS_NULLABLE AS nullable, COLUMN_KEY AS column_key
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    params,
  );
  const keys = await rows(
    connection,
    `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name,
            k.REFERENCED_TABLE_SCHEMA AS to_schema, k.REFERENCED_TABLE_NAME AS to_table,
            k.REFERENCED_COLUMN_NAME AS to_column, r.DELETE_RULE AS on_delete, r.UPDATE_RULE AS on_update
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    params,
  );

  const byTable = new Map<string, DriverSchemaGraph['tables'][number]['columns']>();
  for (const row of columns) {
    const list = byTable.get(String(row.table_name)) ?? [];
    list.push({
      name: String(row.name),
      type: String(row.type),
      nullable: row.nullable === 'YES',
      primaryKey: row.column_key === 'PRI',
    });
    byTable.set(String(row.table_name), list);
  }
  const relations = new Map<string, DbRelation>();
  for (const row of keys) {
    const id = JSON.stringify([row.table_name, row.name]);
    const relation = relations.get(id) ?? {
      name: String(row.name),
      from: { ref: { database, name: String(row.table_name) }, columns: [] },
      to: { ref: { database: String(row.to_schema), name: String(row.to_table) }, columns: [] },
      onDelete: row.on_delete ? String(row.on_delete) : null,
      onUpdate: row.on_update ? String(row.on_update) : null,
    };
    relation.from.columns.push(String(row.column_name));
    relation.to.columns.push(String(row.to_column));
    relations.set(id, relation);
  }
  return {
    database,
    schema: null,
    tables: tables.map((row) => ({
      ref: { database, name: String(row.name) },
      kind: 'table' as const,
      columns: byTable.get(String(row.name)) ?? [],
      rowEstimate: num(row.rows),
    })),
    relations: [...relations.values()],
  };
}

function indexType(name: string, kind: string, engine: string | undefined): DbIndexType {
  const type = kind.toUpperCase();
  if (type === 'FULLTEXT') return 'fulltext';
  if (type === 'SPATIAL') return 'spatial';
  if (type === 'HASH') return 'hash';
  // InnoDB stores the rows in the primary key, which makes it the clustered index.
  if (engine?.toLowerCase() === 'innodb') return name === 'PRIMARY' ? 'clustered' : 'nonclustered';
  return 'btree';
}

export async function mysqlHealth(
  connection: MysqlQueryable,
  database: string,
  engine: 'mysql' | 'mariadb',
): Promise<DbHealthReport> {
  const notes: string[] = [];
  const params = [database];
  // MySQL 8 caches these numbers for a day unless told not to. MariaDB has no such setting.
  await rows(connection, 'SET SESSION information_schema_stats_expiry = 0').catch(() => []);

  const tableRows = await rows(
    connection,
    `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS \`rows\`, DATA_LENGTH AS data,
            INDEX_LENGTH AS idx, DATA_FREE AS free
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    params,
  );
  const engines = new Map(tableRows.map((row) => [String(row.name), row.engine as string]));

  let sizes = new Map<string, number>();
  let pageSize = 16384;
  try {
    pageSize =
      num((await rows(connection, 'SELECT @@innodb_page_size AS page'))[0]?.page) ?? pageSize;
    sizes = new Map(
      (
        await rows(
          connection,
          `SELECT table_name, index_name, stat_value AS pages FROM mysql.innodb_index_stats
            WHERE database_name = ? AND stat_name = 'size'`,
          params,
        )
      ).map((row) => [JSON.stringify([row.table_name, row.index_name]), Number(row.pages)]),
    );
  } catch {
    notes.push('Index sizes need read access to mysql.innodb_index_stats, which this user lacks.');
  }

  const statRows = await rows(
    connection,
    `SELECT TABLE_NAME AS table_name, INDEX_NAME AS name, NON_UNIQUE AS non_unique,
            COLUMN_NAME AS column_name, INDEX_TYPE AS index_type
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
    params,
  );
  const indexes = new Map<string, DbIndexHealth>();
  for (const row of statRows) {
    const table = String(row.table_name);
    const name = String(row.name);
    const id = JSON.stringify([table, name]);
    const pages = sizes.get(id);
    const index = indexes.get(id) ?? {
      table: { database, name: table },
      name,
      type: indexType(name, String(row.index_type ?? ''), engines.get(table)),
      columns: [],
      unique: Number(row.non_unique) === 0,
      primary: name === 'PRIMARY',
      sizeBytes: pages === undefined ? null : pages * pageSize,
      pageCount: pages ?? null,
      fragmentationPercent: null,
    };
    index.columns.push(row.column_name ? String(row.column_name) : '(expression)');
    indexes.set(id, index);
  }

  const tables = tableRows.map((row): DbTableStorage => {
    const data = num(row.data);
    const idx = num(row.idx);
    const free = num(row.free);
    const whole = (data ?? 0) + (idx ?? 0) + (free ?? 0);
    return {
      table: { database, name: String(row.name) },
      rowEstimate: num(row.rows),
      dataBytes: data,
      indexBytes: idx,
      freeBytes: free,
      freePercent: free === null || whole === 0 ? null : Math.round((free / whole) * 1000) / 10,
    };
  });
  const total = (
    await rows(
      connection,
      `SELECT SUM(DATA_LENGTH + INDEX_LENGTH + DATA_FREE) AS size, SUM(DATA_FREE) AS free
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      params,
    )
  )[0];
  notes.push(
    `${engine === 'mariadb' ? 'MariaDB' : 'MySQL'} measures free space per table, so a fix rebuilds the whole table with OPTIMIZE TABLE.`,
  );
  return {
    database,
    measuredAt: new Date().toISOString(),
    method: 'information_schema',
    precise: true,
    canBePrecise: false,
    onlineRebuild: false,
    indexes: [...indexes.values()],
    tables,
    totalBytes: num(total?.size),
    freeBytes: num(total?.free),
    notes,
  };
}
