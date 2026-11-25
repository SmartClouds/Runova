import { buildRowEditStatements } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openPostgres } from './postgres';

/**
 * The SQL the PostgreSQL driver writes itself (catalog lookups, the grid's page, its edits),
 * through a stand-in for pg that records every statement and its parameters. Hostile names have
 * to stay quoted names and hostile values have to travel as parameters, never as text.
 */

const pg = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] | undefined }[] = [];
  const state = { failOn: null as RegExp | null };
  const answer = (text: string) => {
    if (state.failOn?.test(text)) throw new Error('duplicate key value');
    if (/FROM pg_class c JOIN pg_namespace n/.test(text) && /c\.relkind,/.test(text)) {
      return { rows: [{ relkind: 'r', reltuples: 3, definition: null }], rowCount: 1 };
    }
    if (/FROM pg_attribute a/.test(text)) {
      return {
        rows: [
          {
            name: 'id',
            type: 'integer',
            nullable: false,
            default_value: null,
            generated: true,
            primary_key: true,
          },
          {
            name: 'na"me',
            type: 'text',
            nullable: true,
            default_value: null,
            generated: false,
            primary_key: false,
          },
        ],
        rowCount: 2,
      };
    }
    if (/count\(\*\)/.test(text)) return { rows: [{ count: '3' }], rowCount: 1 };
    if (/^(UPDATE|INSERT|DELETE)/.test(text)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0, fields: [], command: 'SELECT' };
  };
  class Client {
    on = () => undefined;
    connect = async () => undefined;
    end = async () => undefined;
    async query(input: string | { text: string }, params?: unknown[]) {
      const text = typeof input === 'string' ? input : input.text;
      calls.push({ text, params });
      return answer(text);
    }
  }
  return { calls, state, Client };
});

vi.mock('pg', () => ({
  default: { Client: pg.Client, types: { getTypeParser: () => (value: string) => value } },
}));

const HOSTILE_NAME = 'x"; DROP TABLE users; --';
const HOSTILE_VALUE = "'; DROP TABLE users; --";
const ALWAYS = "' OR '1'='1";

async function open() {
  return openPostgres({
    engine: 'postgres',
    host: 'db',
    port: 5432,
    user: 'app',
    password: 'pw',
    database: 'shop',
    tls: false,
    srv: false,
  });
}

beforeEach(() => {
  pg.calls.length = 0;
  pg.state.failOn = null;
});

describe('PostgreSQL driver with hostile input', () => {
  it('looks a table up with its schema and name as parameters', async () => {
    const driver = await open();
    await driver.describe({ schema: `public${HOSTILE_VALUE}`, name: HOSTILE_NAME });
    const lookups = pg.calls.filter((call) => /pg_namespace/.test(call.text));
    expect(lookups.length).toBe(3);
    for (const call of lookups) {
      expect(call.params).toEqual([`public${HOSTILE_VALUE}`, HOSTILE_NAME]);
      expect(call.text).not.toContain('DROP');
    }
  });

  it('lists a schema with its name as a parameter', async () => {
    const driver = await open();
    await driver.listObjects({ database: 'shop', schema: ALWAYS, name: ALWAYS }, 'schema');
    const call = pg.calls.find((one) => /relispartition/.test(one.text));
    expect(call?.params).toEqual([ALWAYS]);
    expect(call?.text).not.toContain("'1'='1'");
  });

  it('reads a page of a hostile table with quoted names and an allowlisted direction', async () => {
    const driver = await open();
    await driver.readRows({
      ref: { schema: 's"x', name: HOSTILE_NAME },
      limit: 10,
      offset: 20,
      orderBy: { column: 'na"me', direction: 'DESC; DROP TABLE users' as 'desc' },
    });
    const page = pg.calls.find((call) => call.text.startsWith('SELECT * FROM'));
    expect(page?.text).toBe(
      'SELECT * FROM "s""x"."x""; DROP TABLE users; --" ORDER BY "na""me" ASC LIMIT 10 OFFSET 20',
    );
    const count = pg.calls.find((call) => /count\(\*\)/.test(call.text));
    expect(count?.text).toContain('FROM "s""x"."x""; DROP TABLE users; --"');
    expect(pg.calls.map((call) => call.text)).toContain('BEGIN READ ONLY');
  });

  it('refuses to sort by a column the table does not have', async () => {
    const driver = await open();
    await expect(
      driver.readRows({
        ref: { name: 't' },
        limit: 10,
        offset: 0,
        orderBy: { column: 'id; DROP TABLE users', direction: 'asc' },
      }),
    ).rejects.toThrow(/no column/);
    expect(pg.calls.some((call) => call.text.startsWith('SELECT * FROM'))).toBe(false);
  });

  it('applies edits in one transaction, every value a $n parameter', async () => {
    const driver = await open();
    const statements = buildRowEditStatements(
      'postgres',
      { schema: 'public', name: 'users' },
      [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'text' },
      ],
      [
        { kind: 'update', key: { id: ALWAYS }, values: { name: HOSTILE_VALUE } },
        { kind: 'insert', values: { name: "\\'; DROP TABLE users; --" } },
        { kind: 'delete', key: { id: HOSTILE_VALUE } },
      ],
    );
    expect(await driver.applyEdits?.(statements, 'shop')).toEqual({ affectedRows: 3 });
    expect(pg.calls.slice(-5)).toEqual([
      { text: 'BEGIN', params: undefined },
      {
        text: 'UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2',
        params: [HOSTILE_VALUE, ALWAYS],
      },
      {
        text: 'INSERT INTO "public"."users" ("name") VALUES ($1)',
        params: ["\\'; DROP TABLE users; --"],
      },
      { text: 'DELETE FROM "public"."users" WHERE "id" = $1', params: [HOSTILE_VALUE] },
      { text: 'COMMIT', params: undefined },
    ]);
  });

  it('rolls back and reports the error when an edit fails', async () => {
    const driver = await open();
    pg.state.failOn = /^INSERT/;
    const statements = buildRowEditStatements(
      'postgres',
      { name: 'users' },
      [{ name: 'id', type: 'integer' }],
      [
        { kind: 'delete', key: { id: 1 } },
        { kind: 'insert', values: { id: 1 } },
      ],
    );
    await expect(driver.applyEdits?.(statements, null)).rejects.toThrow(/duplicate key/);
    expect(pg.calls.at(-1)?.text).toBe('ROLLBACK');
    expect(pg.calls.some((call) => call.text === 'COMMIT')).toBe(false);
  });
});
