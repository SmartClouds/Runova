import { buildRowEditStatements } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindParam, openMssql } from './mssql';

/**
 * The SQL the SQL Server driver writes itself, through a stand-in for the mssql package that
 * records every batch and the parameters bound to it. Values have to arrive as @name parameters
 * and names as [bracketed] identifiers, whatever they hold.
 */

const ms = vi.hoisted(() => {
  type Bound = Record<string, { type: unknown; value: unknown }>;
  const batches: { text: string; params: Bound; inTransaction: boolean }[] = [];
  const events: string[] = [];
  const state = { failOn: null as RegExp | null };
  const answer = (text: string) => {
    if (state.failOn?.test(text)) throw new Error('Violation of PRIMARY KEY constraint');
    if (/INFORMATION_SCHEMA\.TABLES/.test(text)) return [{ TABLE_TYPE: 'BASE TABLE' }];
    if (/INFORMATION_SCHEMA\.COLUMNS/.test(text)) {
      return [
        {
          COLUMN_NAME: 'id',
          DATA_TYPE: 'int',
          CHARACTER_MAXIMUM_LENGTH: null,
          IS_NULLABLE: 'NO',
          COLUMN_DEFAULT: null,
          is_identity: true,
          is_pk: 1,
        },
        {
          COLUMN_NAME: 'na]me',
          DATA_TYPE: 'nvarchar',
          CHARACTER_MAXIMUM_LENGTH: 50,
          IS_NULLABLE: 'YES',
          COLUMN_DEFAULT: null,
          is_identity: false,
          is_pk: 0,
        },
      ];
    }
    if (/SUM\(p\.rows\)/.test(text)) return [{ rows: 3 }];
    return [];
  };
  class Request {
    params: Bound = {};
    arrayRowMode = false;
    constructor(readonly transaction: unknown = null) {}
    input(name: string, type: unknown, value: unknown) {
      this.params[name] = { type, value };
      return this;
    }
    cancel = () => undefined;
    async query(text: string) {
      batches.push({ text, params: this.params, inTransaction: this.transaction !== null });
      const recordset = answer(text);
      return {
        recordset,
        recordsets: [recordset],
        rowsAffected: [/^(UPDATE|INSERT|DELETE)/.test(text) ? 1 : 0],
      };
    }
  }
  class ConnectionPool {
    on = () => undefined;
    connect = async () => undefined;
    close = async () => undefined;
    request() {
      return new Request();
    }
  }
  class Transaction {
    async begin() {
      events.push('begin');
    }
    async commit() {
      events.push('commit');
    }
    async rollback() {
      events.push('rollback');
    }
  }
  const NVarChar = (length: number) => ({ type: 'NVarChar', length });
  return { batches, events, state, Request, ConnectionPool, Transaction, NVarChar };
});

vi.mock('mssql', () => ({
  default: {
    ConnectionPool: ms.ConnectionPool,
    Request: ms.Request,
    Transaction: ms.Transaction,
    NVarChar: ms.NVarChar,
    MAX: -1,
    Bit: 'Bit',
  },
}));

const HOSTILE_NAME = 'x]; DROP TABLE users; --';
const HOSTILE_VALUE = "'; DROP TABLE users; --";
const ALWAYS = "' OR '1'='1";

async function open() {
  return openMssql({
    engine: 'mssql',
    host: 'db',
    port: 1433,
    user: 'sa',
    password: 'pw',
    database: 'Shop',
    tls: false,
    srv: false,
  });
}

beforeEach(() => {
  ms.batches.length = 0;
  ms.events.length = 0;
  ms.state.failOn = null;
});

const values = (params: Record<string, { value: unknown }>) =>
  Object.fromEntries(Object.entries(params).map(([name, bound]) => [name, bound.value]));

describe('SQL Server driver with hostile input', () => {
  it('looks a table up with its schema and name bound, and its database bracketed', async () => {
    const driver = await open();
    const table = await driver.describe({
      database: 'Sh]op',
      schema: `dbo${HOSTILE_VALUE}`,
      name: HOSTILE_NAME,
    });
    expect(table.columns.map((column) => column.name)).toEqual(['id', 'na]me']);
    expect(ms.batches).toHaveLength(4);
    for (const batch of ms.batches) {
      expect(batch.text).not.toContain('DROP');
      expect(batch.text).toContain('[Sh]]op].');
      expect(values(batch.params)).toEqual({
        database: 'Sh]op',
        schema: `dbo${HOSTILE_VALUE}`,
        name: HOSTILE_NAME,
      });
    }
    expect(ms.batches[1]?.text).toContain(
      "OBJECT_ID(QUOTENAME(@database) + N'.' + QUOTENAME(@schema) + N'.' + QUOTENAME(@name))",
    );
  });

  it('lists a schema with its name bound', async () => {
    const driver = await open();
    await driver.listObjects({ database: 'Shop', schema: ALWAYS, name: ALWAYS }, 'schema');
    expect(ms.batches).toHaveLength(1);
    expect(ms.batches[0]?.text).toContain('s.name = @schema');
    expect(values(ms.batches[0]?.params ?? {})).toEqual({ schema: ALWAYS });
  });

  it('reads a page with bracketed names and an allowlisted direction', async () => {
    const driver = await open();
    await driver.readRows({
      ref: { database: 'Shop', schema: 'dbo', name: HOSTILE_NAME },
      limit: 10,
      offset: 30,
      orderBy: { column: 'na]me', direction: 'DESC; DROP TABLE users' as 'desc' },
    });
    const page = ms.batches.find((batch) => batch.text.includes('SELECT * FROM'));
    expect(page?.text).toContain(
      'SELECT * FROM [Shop].[dbo].[x]]; DROP TABLE users; --] ORDER BY [na]]me] ASC OFFSET 30 ROWS FETCH NEXT 10 ROWS ONLY',
    );
    expect(page?.text).toMatch(/^SET ROWCOUNT 10;\nBEGIN TRANSACTION;/);
  });

  it('applies edits in one transaction, every value an @p parameter', async () => {
    const driver = await open();
    const statements = buildRowEditStatements(
      'mssql',
      { database: 'Shop', schema: 'dbo', name: 'users' },
      [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'nvarchar(50)' },
        { name: 'active', type: 'bit' },
      ],
      [
        { kind: 'update', key: { id: ALWAYS }, values: { name: HOSTILE_VALUE, active: true } },
        { kind: 'delete', key: { id: 12345678901234 } },
      ],
    );
    expect(await driver.applyEdits?.(statements, null)).toEqual({ affectedRows: 2 });
    expect(ms.events).toEqual(['begin', 'commit']);
    expect(
      ms.batches.map((batch) => [batch.text, values(batch.params), batch.inTransaction]),
    ).toEqual([
      [
        'UPDATE [Shop].[dbo].[users] SET [name] = @p1, [active] = @p2 WHERE [id] = @p3',
        { p1: HOSTILE_VALUE, p2: true, p3: ALWAYS },
        true,
      ],
      // A number is bound as its text, so a bigint key keeps every digit.
      ['DELETE FROM [Shop].[dbo].[users] WHERE [id] = @p1', { p1: '12345678901234' }, true],
    ]);
  });

  it('rolls back when an edit fails', async () => {
    const driver = await open();
    ms.state.failOn = /^INSERT/;
    const statements = buildRowEditStatements(
      'mssql',
      { schema: 'dbo', name: 'users' },
      [{ name: 'id', type: 'int' }],
      [
        { kind: 'delete', key: { id: 2 } },
        { kind: 'insert', values: { id: 1 } },
      ],
    );
    await expect(driver.applyEdits?.(statements, null)).rejects.toThrow(/PRIMARY KEY/);
    expect(ms.events).toEqual(['begin', 'rollback']);
  });
});

describe('bindParam', () => {
  it('binds text as nvarchar(max), booleans as bit and numbers as their text', () => {
    const request = new ms.Request();
    bindParam(request as never, 'a', "it's");
    bindParam(request as never, 'b', false);
    bindParam(request as never, 'c', 1.5);
    bindParam(request as never, 'd', null);
    expect(request.params).toEqual({
      a: { type: { type: 'NVarChar', length: -1 }, value: "it's" },
      b: { type: 'Bit', value: false },
      c: { type: { type: 'NVarChar', length: -1 }, value: '1.5' },
      d: { type: { type: 'NVarChar', length: -1 }, value: null },
    });
  });
});
