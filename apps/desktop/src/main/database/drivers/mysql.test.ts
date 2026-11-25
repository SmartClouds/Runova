import { buildRowEditStatements } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessFromGrants, openMysql } from './mysql';

/** MySQL's SHOW GRANTS lines, read as the access levels the Users tab shows. */

describe('accessFromGrants', () => {
  it('reads each database at its highest level', () => {
    expect(
      accessFromGrants([
        'GRANT USAGE ON *.* TO `app`@`%`',
        'GRANT SELECT ON `shop`.* TO `app`@`%`',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.* TO `app`@`%`',
        'GRANT SELECT ON `blog`.* TO `app`@`%`',
      ]),
    ).toEqual([
      { database: 'shop', level: 'write' },
      { database: 'blog', level: 'read' },
    ]);
  });

  it('reads ALL PRIVILEGES on *.* as admin of every database', () => {
    expect(
      accessFromGrants(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%` WITH GRANT OPTION']),
    ).toEqual([{ database: '*', level: 'admin' }]);
  });

  it('skips grants on single tables and ones it does not understand', () => {
    expect(
      accessFromGrants([
        'GRANT SELECT ON `shop`.`orders` TO `x`@`%`',
        'GRANT PROXY ON ``@`` TO `x`@`%`',
      ]),
    ).toEqual([]);
  });
});

/**
 * The SQL the MySQL driver writes itself, through a stand-in for mysql2 that records each call.
 * A value must go through execute(), which the server binds, never through query() with values,
 * which mysql2 formats into the text with backslash escapes that NO_BACKSLASH_ESCAPES reads
 * differently. Names must stay backtick-quoted names.
 */

const my = vi.hoisted(() => {
  const queries: { sql: string; params: unknown }[] = [];
  const executes: { sql: string; params: unknown[] }[] = [];
  const state = { failOn: null as RegExp | null };
  const rowsFor = (sql: string): unknown => {
    if (state.failOn?.test(sql)) throw new Error("Duplicate entry '1' for key 'PRIMARY'");
    if (/information_schema\.TABLES WHERE TABLE_SCHEMA = \? AND TABLE_NAME/.test(sql)) {
      return [{ type: 'BASE TABLE', estimate: 3 }];
    }
    if (/information_schema\.COLUMNS/.test(sql)) {
      return [
        {
          name: 'id',
          type: 'int',
          nullable: 'NO',
          defaultValue: null,
          columnKey: 'PRI',
          extra: 'auto_increment',
        },
        {
          name: 'na`me',
          type: 'text',
          nullable: 'YES',
          defaultValue: null,
          columnKey: '',
          extra: '',
        },
      ];
    }
    if (/FROM mysql\.user/.test(sql)) {
      return [{ user: "app\\'; DROP USER root; --", host: "%' OR '1'='1", super: 'N' }];
    }
    if (/^(UPDATE|INSERT|DELETE)/.test(sql)) return { affectedRows: 1 };
    if (/COUNT\(\*\)/.test(sql)) return [{ total: 3 }];
    return [];
  };
  const connection = {
    threadId: 7,
    on: () => undefined,
    end: async () => undefined,
    destroy: () => undefined,
    async beginTransaction() {
      queries.push({ sql: 'START TRANSACTION', params: undefined });
    },
    async commit() {
      queries.push({ sql: 'COMMIT', params: undefined });
    },
    async rollback() {
      queries.push({ sql: 'ROLLBACK', params: undefined });
    },
    async query(input: string | { sql: string }, params?: unknown) {
      const sql = typeof input === 'string' ? input : input.sql;
      queries.push({ sql, params });
      return [rowsFor(sql), []];
    },
    async execute(sql: string, params: unknown[]) {
      executes.push({ sql, params });
      return [rowsFor(sql), []];
    },
  };
  return { queries, executes, state, connection };
});

vi.mock('mysql2/promise', () => ({
  default: { createConnection: async () => my.connection },
}));

const HOSTILE_NAME = 'x`; DROP TABLE users; --';
const HOSTILE_VALUE = "\\'; DROP TABLE users; --";
const ALWAYS = "' OR '1'='1";

async function open() {
  return openMysql({
    engine: 'mysql',
    host: 'db',
    port: 3306,
    user: 'app',
    password: 'pw',
    database: 'shop',
    tls: false,
    srv: false,
  });
}

beforeEach(() => {
  my.queries.length = 0;
  my.executes.length = 0;
  my.state.failOn = null;
});

describe('MySQL driver with hostile input', () => {
  it('looks a table up with prepared statements, and never formats a value into query()', async () => {
    const driver = await open();
    await driver.describe({ database: `shop${HOSTILE_VALUE}`, name: HOSTILE_NAME });
    expect(my.executes).toHaveLength(3);
    for (const call of my.executes) {
      expect(call.params).toEqual([`shop${HOSTILE_VALUE}`, HOSTILE_NAME]);
      expect(call.sql).not.toContain('DROP');
    }
    for (const call of my.queries) expect(call.params).toBeUndefined();
    const create = my.queries.find((call) => call.sql.startsWith('SHOW CREATE'));
    expect(create?.sql).toBe(
      "SHOW CREATE TABLE `shop\\'; DROP TABLE users; --`.`x``; DROP TABLE users; --`",
    );
  });

  it('lists a database with its name bound', async () => {
    const driver = await open();
    await driver.listObjects({ database: ALWAYS, name: ALWAYS }, 'database');
    expect(my.executes).toEqual([expect.objectContaining({ params: [ALWAYS] })]);
  });

  it('reads a page of a hostile table with quoted names and an allowlisted direction', async () => {
    const driver = await open();
    await driver.readRows({
      ref: { database: 'shop', name: HOSTILE_NAME },
      limit: 10,
      offset: 0,
      orderBy: { column: 'na`me', direction: 'desc' },
    });
    const page = my.queries.find((call) => call.sql.startsWith('SELECT * FROM'));
    expect(page?.sql).toBe(
      'SELECT * FROM `shop`.`x``; DROP TABLE users; --` ORDER BY `na``me` DESC LIMIT 10 OFFSET 0',
    );
    expect(my.queries.map((call) => call.sql)).toContain('START TRANSACTION READ ONLY');
  });

  it('applies edits in one transaction through execute(), every value a ? parameter', async () => {
    const driver = await open();
    const statements = buildRowEditStatements(
      'mysql',
      { database: 'shop', name: 'users' },
      [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'text' },
      ],
      [
        { kind: 'update', key: { id: ALWAYS }, values: { name: HOSTILE_VALUE } },
        { kind: 'delete', key: { id: HOSTILE_VALUE } },
      ],
    );
    expect(await driver.applyEdits?.(statements, null)).toEqual({ affectedRows: 2 });
    expect(my.executes).toEqual([
      {
        sql: 'UPDATE `shop`.`users` SET `name` = ? WHERE `id` = ?',
        params: [HOSTILE_VALUE, ALWAYS],
      },
      { sql: 'DELETE FROM `shop`.`users` WHERE `id` = ?', params: [HOSTILE_VALUE] },
    ]);
    expect(my.queries.map((call) => call.sql)).toEqual(['START TRANSACTION', 'COMMIT']);
  });

  it('writes an account name read from the server into SHOW GRANTS with its quotes doubled', async () => {
    const driver = await open();
    await driver.users?.();
    const shown = my.queries.find((call) => call.sql.startsWith('SHOW GRANTS'));
    // Doubled quotes stay inside the string whether or not backslashes are escapes.
    expect(shown?.sql).toBe("SHOW GRANTS FOR 'app\\\\''; DROP USER root; --'@'%'' OR ''1''=''1'");
    expect(shown?.params).toBeUndefined();
  });

  it('rolls back when an edit fails', async () => {
    const driver = await open();
    my.state.failOn = /^INSERT/;
    const statements = buildRowEditStatements(
      'mysql',
      { database: 'shop', name: 'users' },
      [{ name: 'id', type: 'int' }],
      [
        { kind: 'delete', key: { id: 2 } },
        { kind: 'insert', values: { id: 1 } },
      ],
    );
    await expect(driver.applyEdits?.(statements, null)).rejects.toThrow(/Duplicate entry/);
    expect(my.queries.map((call) => call.sql)).toEqual(['START TRANSACTION', 'ROLLBACK']);
  });
});
