import { describe, expect, it, vi } from 'vitest';
import { estimateBtreeBloat, pgHealth, pgSchemaGraph } from './postgresInsights';

/**
 * The PostgreSQL diagram and health queries, read through a fake client that answers by the
 * catalog each query reads. The real queries run against Postgres in sql.int.test.ts.
 */

type Rows = Record<string, unknown>[];

function fakeClient(answers: [RegExp, Rows | ((params: unknown[]) => Rows) | Error][]) {
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    for (const [pattern, answer] of answers) {
      if (!pattern.test(text)) continue;
      if (answer instanceof Error) throw answer;
      return { rows: typeof answer === 'function' ? answer(params) : answer };
    }
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  });
  return { query };
}

describe('pgSchemaGraph', () => {
  const client = fakeClient([
    [
      /FROM pg_constraint/,
      [
        {
          name: 'orders_customer_fk',
          from_schema: 'sales',
          from_table: 'orders',
          from_columns: ['customer_id'],
          to_schema: 'crm',
          to_table: 'customers',
          to_columns: ['id'],
          on_delete: 'c',
          on_update: 'a',
        },
      ],
    ],
    [
      /FROM pg_attribute/,
      [
        {
          schema: 'sales',
          table: 'orders',
          name: 'id',
          type: 'integer',
          nullable: false,
          primary_key: true,
        },
        {
          schema: 'sales',
          table: 'orders',
          name: 'customer_id',
          type: 'integer',
          nullable: true,
          primary_key: false,
        },
      ],
    ],
    [/FROM pg_class/, [{ schema: 'sales', name: 'orders', reltuples: 1200 }]],
  ]);

  it('reads tables, columns and foreign keys in three queries for one schema', async () => {
    const graph = await pgSchemaGraph(client, 'shop', 'sales');
    expect(client.query).toHaveBeenCalledTimes(3);
    for (const call of client.query.mock.calls) expect(call[1]).toEqual(['sales']);
    expect(graph).toEqual({
      database: 'shop',
      schema: 'sales',
      tables: [
        {
          ref: { database: 'shop', schema: 'sales', name: 'orders' },
          kind: 'table',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'customer_id', type: 'integer', nullable: true, primaryKey: false },
          ],
          rowEstimate: 1200,
        },
      ],
      relations: [
        {
          name: 'orders_customer_fk',
          from: {
            ref: { database: 'shop', schema: 'sales', name: 'orders' },
            columns: ['customer_id'],
          },
          to: { ref: { database: 'shop', schema: 'crm', name: 'customers' }, columns: ['id'] },
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION',
        },
      ],
    });
  });

  it('reads every schema when none is named', async () => {
    const all = fakeClient([[/./, []]]);
    await pgSchemaGraph(all, 'shop', null);
    for (const call of all.query.mock.calls) expect(call[1]).toEqual([null]);
  });
});

describe('estimateBtreeBloat', () => {
  it('reads an index twice the size it needs as about half bloat', () => {
    // 100,000 rows of 4-byte keys need about 100000 * 20 / (8168 * 0.9) = 272 pages.
    expect(estimateBtreeBloat({ pages: 544, tuples: 100_000, keyWidth: 4 })).toBeCloseTo(50, 0);
  });

  it('says nothing for an index with no statistics yet', () => {
    expect(estimateBtreeBloat({ pages: 10, tuples: -1, keyWidth: 4 })).toBeNull();
    expect(estimateBtreeBloat({ pages: 10, tuples: 100, keyWidth: null })).toBeNull();
    expect(estimateBtreeBloat({ pages: 0, tuples: 0, keyWidth: 4 })).toBeNull();
  });

  it('never goes below zero', () => {
    expect(estimateBtreeBloat({ pages: 10, tuples: 100_000, keyWidth: 4 })).toBe(0);
  });
});

describe('pgHealth', () => {
  const indexRow = {
    oid: 101,
    schema: 'public',
    table: 'orders',
    name: 'orders_pkey',
    method: 'btree',
    unique: true,
    primary: true,
    columns: ['id'],
    size_bytes: '4456448',
    pages: 544,
    tuples: 100_000,
    key_width: 4,
  };
  const tableRow = {
    schema: 'public',
    table: 'orders',
    reltuples: 100_000,
    data_bytes: '9000000',
    index_bytes: '4456448',
    live: '90000',
    dead: '10000',
    last_vacuum: new Date('2026-11-01T00:00:00Z'),
    last_analyze: null,
  };

  it('estimates bloat from statistics when pgstattuple is not there, and says it can be added', async () => {
    const client = fakeClient([
      [/pg_extension/, [{ installed: false, available: true }]],
      [/FROM pg_index/, [indexRow, { ...indexRow, oid: 102, name: 'orders_gin', method: 'gin' }]],
      [/pg_stat_user_tables/, [tableRow]],
      [/pg_database_size/, [{ size: '20000000' }]],
    ]);
    const report = await pgHealth(client, 'shop', null, 'thorough');
    expect(report).toMatchObject({
      database: 'shop',
      precise: false,
      canBePrecise: true,
      onlineRebuild: false,
      totalBytes: 20_000_000,
      freeBytes: null,
    });
    expect(report.indexes[0]).toMatchObject({
      table: { database: 'shop', schema: 'public', name: 'orders' },
      name: 'orders_pkey',
      type: 'btree',
      sizeBytes: 4_456_448,
      pageCount: 544,
    });
    expect(report.indexes[0]?.fragmentationPercent).toBeCloseTo(50, 0);
    // Bloat is estimated for B-trees only.
    expect(report.indexes[1]).toMatchObject({ type: 'gin', fragmentationPercent: null });
    expect(report.tables[0]).toEqual({
      table: { database: 'shop', schema: 'public', name: 'orders' },
      rowEstimate: 100_000,
      dataBytes: 9_000_000,
      indexBytes: 4_456_448,
      freeBytes: 900_000,
      freePercent: 10,
      deadRows: 10_000,
      lastVacuum: '2026-11-01T00:00:00.000Z',
      lastAnalyze: null,
    });
    expect(client.query.mock.calls.some((call) => /pgstatindex/.test(call[0]))).toBe(false);
  });

  it('reads exact numbers with pgstatindex on a thorough scan', async () => {
    const client = fakeClient([
      [/pg_extension/, [{ installed: true, available: true }]],
      [/FROM pg_index/, [indexRow]],
      [/pgstatindex/, [{ avg_leaf_density: 45, leaf_fragmentation: 12 }]],
      [/pg_stat_user_tables/, []],
      [/pg_database_size/, [{ size: '1' }]],
    ]);
    const report = await pgHealth(client, 'shop', 'public', 'thorough');
    expect(report.precise).toBe(true);
    expect(report.canBePrecise).toBe(false);
    // Packed to 45% where 90% is normal: half of it is bloat.
    expect(report.indexes[0]?.fragmentationPercent).toBe(50);
  });

  it('keeps to the estimate on a fast scan, and says a thorough one is exact', async () => {
    const client = fakeClient([
      [/pg_extension/, [{ installed: true, available: true }]],
      [/FROM pg_index/, [indexRow]],
      [/pg_stat_user_tables/, []],
      [/pg_database_size/, [{ size: '1' }]],
    ]);
    const report = await pgHealth(client, 'shop', null, 'fast');
    expect(report.precise).toBe(false);
    expect(report.notes.join(' ')).toMatch(/thorough/i);
  });

  it('falls back to the estimate for an index pgstatindex cannot read', async () => {
    const client = fakeClient([
      [/pg_extension/, [{ installed: true, available: true }]],
      [/FROM pg_index/, [indexRow]],
      [/pgstatindex/, new Error('permission denied for function pgstatindex')],
      [/pg_stat_user_tables/, []],
      [/pg_database_size/, [{ size: '1' }]],
    ]);
    const report = await pgHealth(client, 'shop', null, 'thorough');
    expect(report.indexes[0]?.fragmentationPercent).toBeCloseTo(50, 0);
    expect(report.precise).toBe(false);
    expect(report.notes.join(' ')).toMatch(/permission denied/);
  });
});
