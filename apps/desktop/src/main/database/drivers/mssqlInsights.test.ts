import { describe, expect, it, vi } from 'vitest';
import { mssqlHealth, mssqlSchemaGraph } from './mssqlInsights';
import { DriverError } from './types';

/** The SQL Server diagram and health queries, through a fake that answers by the view read. */

type Rows = Record<string, unknown>[];

function fakeRows(answers: [RegExp, Rows | Error][]) {
  return vi.fn(async (text: string): Promise<Rows> => {
    for (const [pattern, answer] of answers) {
      if (!pattern.test(text)) continue;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  });
}

describe('mssqlSchemaGraph', () => {
  it('reads tables, typed columns and foreign keys in the database asked for', async () => {
    const rows = fakeRows([
      [
        /sys\.foreign_keys/,
        [
          {
            name: 'FK_Orders_Customers',
            from_schema: 'sales',
            from_table: 'Orders',
            from_column: 'CustomerId',
            to_schema: 'crm',
            to_table: 'Customers',
            to_column: 'Id',
            on_delete: 'SET_NULL',
            on_update: 'NO_ACTION',
          },
        ],
      ],
      [
        /sys\.columns/,
        [
          {
            schema: 'sales',
            table: 'Orders',
            name: 'Id',
            type: 'int',
            max_length: 4,
            precision: 10,
            scale: 0,
            is_nullable: false,
            pk: 1,
          },
          {
            schema: 'sales',
            table: 'Orders',
            name: 'Note',
            type: 'nvarchar',
            max_length: 200,
            precision: 0,
            scale: 0,
            is_nullable: true,
            pk: 0,
          },
          {
            schema: 'sales',
            table: 'Orders',
            name: 'Body',
            type: 'varchar',
            max_length: -1,
            precision: 0,
            scale: 0,
            is_nullable: true,
            pk: 0,
          },
          {
            schema: 'sales',
            table: 'Orders',
            name: 'Total',
            type: 'decimal',
            max_length: 9,
            precision: 12,
            scale: 2,
            is_nullable: false,
            pk: 0,
          },
        ],
      ],
      [/sys\.tables/, [{ schema: 'sales', name: 'Orders', rows: 42 }]],
    ]);
    const graph = await mssqlSchemaGraph(rows, 'Shop', 'sales');
    for (const [text] of rows.mock.calls) {
      expect(text.startsWith('USE [Shop];')).toBe(true);
      expect(text).toContain("s.name = N'sales'");
    }
    expect(graph.tables).toEqual([
      {
        ref: { database: 'Shop', schema: 'sales', name: 'Orders' },
        kind: 'table',
        columns: [
          { name: 'Id', type: 'int', nullable: false, primaryKey: true },
          { name: 'Note', type: 'nvarchar(100)', nullable: true, primaryKey: false },
          { name: 'Body', type: 'varchar(max)', nullable: true, primaryKey: false },
          { name: 'Total', type: 'decimal(12,2)', nullable: false, primaryKey: false },
        ],
        rowEstimate: 42,
      },
    ]);
    expect(graph.relations).toEqual([
      {
        name: 'FK_Orders_Customers',
        from: {
          ref: { database: 'Shop', schema: 'sales', name: 'Orders' },
          columns: ['CustomerId'],
        },
        to: { ref: { database: 'Shop', schema: 'crm', name: 'Customers' }, columns: ['Id'] },
        onDelete: 'SET NULL',
        onUpdate: 'NO ACTION',
      },
    ]);
  });

  it('reads every schema when none is named', async () => {
    const rows = fakeRows([[/./, []]]);
    await mssqlSchemaGraph(rows, 'Shop', null);
    for (const [text] of rows.mock.calls) expect(text).not.toContain("s.name = N'");
  });
});

describe('mssqlHealth', () => {
  const physical: Rows = [
    {
      schema: 'dbo',
      table: 'Orders',
      name: 'PK_Orders',
      index_id: 1,
      type_desc: 'CLUSTERED',
      is_unique: true,
      is_primary_key: true,
      frag: 41.237,
      pages: 5000,
    },
    {
      schema: 'dbo',
      table: 'Orders',
      name: 'IX_Orders_Placed',
      index_id: 2,
      type_desc: 'NONCLUSTERED',
      is_unique: false,
      is_primary_key: false,
      frag: 12,
      pages: 1500,
    },
    {
      schema: 'dbo',
      table: 'Log',
      name: null,
      index_id: 0,
      type_desc: 'HEAP',
      is_unique: false,
      is_primary_key: false,
      frag: 3,
      pages: 20,
    },
  ];
  const answers = (stats: Rows | Error, edition = 3): [RegExp, Rows | Error][] => [
    [/EngineEdition/, [{ edition }]],
    [/dm_db_index_physical_stats/, stats],
    [
      /sys\.index_columns/,
      [
        { index_id: 1, schema: 'dbo', table: 'Orders', column_name: 'Id' },
        { index_id: 2, schema: 'dbo', table: 'Orders', column_name: 'PlacedAt' },
        { index_id: 2, schema: 'dbo', table: 'Orders', column_name: 'State' },
      ],
    ],
    [
      /dm_db_partition_stats/,
      [
        {
          schema: 'dbo',
          table: 'Orders',
          rows: 90000,
          data_bytes: 40960000,
          index_bytes: 12288000,
          free_bytes: 819200,
        },
      ],
    ],
    [/database_files/, [{ size: 104857600, free: 52428800 }]],
  ];

  it('reads clustered, nonclustered and heap fragmentation the fast way', async () => {
    const rows = fakeRows(answers(physical));
    const report = await mssqlHealth(rows, 'Shop', null, 'fast');
    const scan = rows.mock.calls.find(([text]) => /dm_db_index_physical_stats/.test(text))?.[0];
    expect(scan).toContain("'LIMITED'");
    expect(report.indexes).toEqual([
      {
        table: { database: 'Shop', schema: 'dbo', name: 'Orders' },
        name: 'PK_Orders',
        type: 'clustered',
        columns: ['Id'],
        unique: true,
        primary: true,
        sizeBytes: 5000 * 8192,
        pageCount: 5000,
        fragmentationPercent: 41.2,
      },
      {
        table: { database: 'Shop', schema: 'dbo', name: 'Orders' },
        name: 'IX_Orders_Placed',
        type: 'nonclustered',
        columns: ['PlacedAt', 'State'],
        unique: false,
        primary: false,
        sizeBytes: 1500 * 8192,
        pageCount: 1500,
        fragmentationPercent: 12,
      },
      {
        table: { database: 'Shop', schema: 'dbo', name: 'Log' },
        name: null,
        type: 'heap',
        columns: [],
        unique: false,
        primary: false,
        sizeBytes: 20 * 8192,
        pageCount: 20,
        fragmentationPercent: 3,
      },
    ]);
    expect(report.tables[0]).toEqual({
      table: { database: 'Shop', schema: 'dbo', name: 'Orders' },
      rowEstimate: 90000,
      dataBytes: 40960000,
      indexBytes: 12288000,
      freeBytes: 819200,
      freePercent: 1.5,
    });
    expect(report).toMatchObject({
      database: 'Shop',
      precise: true,
      onlineRebuild: true,
      totalBytes: 104857600,
      freeBytes: 52428800,
    });
    expect(report.method).toMatch(/LIMITED/);
  });

  it('samples on a thorough scan', async () => {
    const rows = fakeRows(answers(physical));
    const report = await mssqlHealth(rows, 'Shop', 'dbo', 'thorough');
    const scan = rows.mock.calls.find(([text]) => /dm_db_index_physical_stats/.test(text))?.[0];
    expect(scan).toContain("'SAMPLED'");
    expect(scan).toContain("s.name = N'dbo'");
    expect(report.method).toMatch(/SAMPLED/);
  });

  it('knows Standard and Express cannot rebuild online', async () => {
    const report = await mssqlHealth(fakeRows(answers(physical, 2)), 'Shop', null, 'fast');
    expect(report.onlineRebuild).toBe(false);
  });

  it('names the permission when fragmentation cannot be read', async () => {
    const denied = Object.assign(
      new Error("VIEW DATABASE STATE permission denied in database 'Shop'."),
      { number: 297 },
    );
    const failure = mssqlHealth(fakeRows(answers(denied)), 'Shop', null, 'fast');
    await expect(failure).rejects.toThrow(DriverError);
    await expect(mssqlHealth(fakeRows(answers(denied)), 'Shop', null, 'fast')).rejects.toThrow(
      /VIEW DATABASE STATE/,
    );
  });
});
