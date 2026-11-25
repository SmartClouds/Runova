import { describe, expect, it, vi } from 'vitest';
import { mysqlHealth, mysqlSchemaGraph } from './mysqlInsights';

/** The MySQL and MariaDB diagram and health queries, through a fake connection. */

type Rows = Record<string, unknown>[];

function fakeConnection(answers: [RegExp, Rows | Error][]) {
  const answer = async (sql: string) => {
    for (const [pattern, rows] of answers) {
      if (!pattern.test(sql)) continue;
      if (rows instanceof Error) throw rows;
      return [rows, []] as [Rows, unknown[]];
    }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  };
  const query = vi.fn(async (sql: string) => answer(sql));
  const execute = vi.fn(async (sql: string, _params: string[]) => answer(sql));
  return { query, execute };
}

describe('mysqlSchemaGraph', () => {
  it('reads tables, columns and multi-column foreign keys', async () => {
    const connection = fakeConnection([
      [
        /REFERENTIAL_CONSTRAINTS/,
        [
          {
            name: 'fk_line_order',
            table_name: 'lines',
            column_name: 'order_id',
            to_schema: 'shop',
            to_table: 'orders',
            to_column: 'id',
            on_delete: 'CASCADE',
            on_update: 'RESTRICT',
          },
          {
            name: 'fk_line_order',
            table_name: 'lines',
            column_name: 'order_rev',
            to_schema: 'shop',
            to_table: 'orders',
            to_column: 'rev',
            on_delete: 'CASCADE',
            on_update: 'RESTRICT',
          },
        ],
      ],
      [
        /information_schema\.COLUMNS/,
        [
          { table_name: 'lines', name: 'order_id', type: 'int', nullable: 'NO', column_key: 'MUL' },
          { table_name: 'orders', name: 'id', type: 'int', nullable: 'NO', column_key: 'PRI' },
        ],
      ],
      [
        /information_schema\.TABLES/,
        [
          { name: 'lines', rows: '10' },
          { name: 'orders', rows: null },
        ],
      ],
    ]);
    const graph = await mysqlSchemaGraph(connection, 'shop');
    expect(connection.query).not.toHaveBeenCalled();
    for (const call of connection.execute.mock.calls) expect(call[1]).toEqual(['shop']);
    expect(graph.tables).toEqual([
      {
        ref: { database: 'shop', name: 'lines' },
        kind: 'table',
        columns: [{ name: 'order_id', type: 'int', nullable: false, primaryKey: false }],
        rowEstimate: 10,
      },
      {
        ref: { database: 'shop', name: 'orders' },
        kind: 'table',
        columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }],
        rowEstimate: null,
      },
    ]);
    expect(graph.relations).toEqual([
      {
        name: 'fk_line_order',
        from: { ref: { database: 'shop', name: 'lines' }, columns: ['order_id', 'order_rev'] },
        to: { ref: { database: 'shop', name: 'orders' }, columns: ['id', 'rev'] },
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      },
    ]);
  });
});

describe('mysqlHealth', () => {
  const answers = (sizes: Rows | Error): [RegExp, Rows | Error][] => [
    [/information_schema_stats_expiry/, []],
    [/SUM\(DATA_LENGTH/, [{ size: '50000000', free: '10000000' }]],
    [/innodb_page_size/, [{ page: 16384 }]],
    [/innodb_index_stats/, sizes],
    [
      /information_schema\.STATISTICS/,
      [
        {
          table_name: 'orders',
          name: 'PRIMARY',
          non_unique: 0,
          column_name: 'id',
          index_type: 'BTREE',
        },
        {
          table_name: 'orders',
          name: 'ix_placed',
          non_unique: 1,
          column_name: 'placed',
          index_type: 'BTREE',
        },
        {
          table_name: 'orders',
          name: 'ix_placed',
          non_unique: 1,
          column_name: 'state',
          index_type: 'BTREE',
        },
        {
          table_name: 'orders',
          name: 'ft_note',
          non_unique: 1,
          column_name: 'note',
          index_type: 'FULLTEXT',
        },
      ],
    ],
    [
      /information_schema\.TABLES/,
      [
        {
          name: 'orders',
          engine: 'InnoDB',
          rows: '1000',
          data: '30000000',
          idx: '10000000',
          free: '10000000',
        },
      ],
    ],
  ];

  it('measures free space per table, and calls the InnoDB primary key clustered', async () => {
    const report = await mysqlHealth(
      fakeConnection(answers([{ table_name: 'orders', index_name: 'ix_placed', pages: '64' }])),
      'shop',
      'mysql',
    );
    expect(report.tables).toEqual([
      {
        table: { database: 'shop', name: 'orders' },
        rowEstimate: 1000,
        dataBytes: 30_000_000,
        indexBytes: 10_000_000,
        freeBytes: 10_000_000,
        freePercent: 20,
      },
    ]);
    expect(report.indexes.map((index) => [index.name, index.type, index.columns])).toEqual([
      ['PRIMARY', 'clustered', ['id']],
      ['ix_placed', 'nonclustered', ['placed', 'state']],
      ['ft_note', 'fulltext', ['note']],
    ]);
    expect(report.indexes[0]).toMatchObject({ unique: true, primary: true });
    expect(report.indexes[1]).toMatchObject({ sizeBytes: 64 * 16384, pageCount: 64 });
    expect(report).toMatchObject({ totalBytes: 50_000_000, freeBytes: 10_000_000, precise: true });
  });

  it('carries on without index sizes when mysql.innodb_index_stats is closed to the user', async () => {
    const report = await mysqlHealth(
      fakeConnection(answers(new Error("SELECT command denied to user 'app'"))),
      'shop',
      'mariadb',
    );
    expect(report.indexes[1]).toMatchObject({ sizeBytes: null, pageCount: null });
    expect(report.notes.join(' ')).toMatch(/index sizes/i);
  });

  it('binds a database name that tries to end its string as a parameter, never as text', async () => {
    const hostile = "shop' OR '1'='1'; DROP TABLE orders; -- \\'";
    const connection = fakeConnection([[/./, []]]);
    await mysqlHealth(connection, hostile, 'mysql');
    await mysqlSchemaGraph(connection, hostile);
    expect(connection.execute.mock.calls.length).toBeGreaterThan(0);
    for (const [sql, params] of connection.execute.mock.calls) {
      expect(params).toEqual([hostile]);
      expect(sql).not.toContain('shop');
    }
    for (const [sql] of connection.query.mock.calls) expect(sql).not.toContain('shop');
  });
});
