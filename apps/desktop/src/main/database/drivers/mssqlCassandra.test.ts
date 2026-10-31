import { describe, expect, it } from 'vitest';
import { cqlResult } from './cassandra';
import { readOnlyBatch, splitBatches } from './mssql';

/** The parts of the SQL Server and Cassandra drivers that need no server to check. */

describe('splitBatches', () => {
  it('splits T-SQL on GO lines only, keeping semicolons inside a batch', () => {
    expect(
      splitBatches('SELECT 1; SELECT 2\nGO\nCREATE PROCEDURE p AS BEGIN SELECT 1; END\n  go  \n'),
    ).toEqual(['SELECT 1; SELECT 2', 'CREATE PROCEDURE p AS BEGIN SELECT 1; END']);
    expect(splitBatches('SELECT 1\nGO 2\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not split on GO inside a word', () => {
    expect(splitBatches('SELECT category FROM goods')).toEqual(['SELECT category FROM goods']);
  });
});

describe('readOnlyBatch', () => {
  it('caps rows and always rolls back', () => {
    const wrapped = readOnlyBatch('SELECT * FROM t', 11);
    expect(wrapped).toMatch(/^SET ROWCOUNT 11;\nBEGIN TRANSACTION;\nSELECT \* FROM t/);
    expect(wrapped).toMatch(/ROLLBACK TRANSACTION;\nSET ROWCOUNT 0;$/);
  });
});

describe('cqlResult', () => {
  it('maps rows in column order with type names, and caps them', () => {
    const result = cqlResult(
      [
        { name: 'id', type: { code: 12 } },
        { name: 'name', type: { code: 13 } },
      ],
      [
        { name: 'Ada', id: 1 },
        { name: 'Grace', id: 2 },
        { name: 'Linus', id: 3 },
      ],
      'SELECT * FROM t',
      Date.now(),
      2,
    );
    expect(result.columns).toEqual([
      { name: 'id', type: 'uuid' },
      { name: 'name', type: 'varchar' },
    ]);
    expect(result.rows).toEqual([
      [1, 'Ada'],
      [2, 'Grace'],
    ]);
    expect(result.truncated).toBe(true);
  });

  it('reads a statement with no rows as an empty result', () => {
    expect(cqlResult(undefined, undefined, 'INSERT', Date.now(), 10)).toMatchObject({
      columns: [],
      rows: [],
      truncated: false,
    });
  });
});
