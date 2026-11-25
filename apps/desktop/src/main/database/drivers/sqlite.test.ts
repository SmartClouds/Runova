import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRowEditStatements, buildRowEdits } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver } from './index';
import type { DbDriver } from './types';

/**
 * The SQLite driver on a real file: browsing, structure, paging, queries, read-only runs and a
 * batch of row edits that is all or nothing.
 */

let driver: DbDriver;

const run = (text: string, readOnly = false, maxRows = 100) =>
  driver.query(text, { maxRows, readOnly, signal: new AbortController().signal });

beforeEach(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'runova-sqlite-')), 'shop.db');
  const { DatabaseSync } = await import('node:sqlite');
  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL DEFAULT 0);
    CREATE INDEX items_name ON items (name);
    CREATE VIEW cheap AS SELECT * FROM items WHERE price < 3;
    INSERT INTO items (name, price) VALUES ('apple', 1.5), ('pear', 2), ('plum', 3.25);
  `);
  seed.close();
  driver = await openDriver({
    engine: 'sqlite',
    host: '',
    port: null,
    file,
    tls: false,
    srv: false,
  });
});

afterEach(async () => {
  await driver.close();
});

describe('SQLite driver', () => {
  it('says which version it is and lists tables and views', async () => {
    expect(await driver.serverVersion()).toMatch(/^3\./);
    expect((await driver.listObjects(null, null)).map((node) => [node.kind, node.name])).toEqual([
      ['view', 'cheap'],
      ['table', 'items'],
    ]);
  });

  it('describes a table, its rowid key and its index', async () => {
    const table = await driver.describe({ name: 'items' });
    expect(table.columns[0]).toMatchObject({ name: 'id', primaryKey: true, generated: true });
    expect(table.columns[1]).toMatchObject({ name: 'name', nullable: false });
    expect(table.indexes.map((index) => index.name)).toContain('items_name');
    expect(table.rowEstimate).toBe(3);
    expect(table.definition).toMatch(/^CREATE TABLE items/);
  });

  it('reads a sorted, filtered page with the key for editing', async () => {
    const page = await driver.readRows({
      ref: { name: 'items' },
      limit: 2,
      offset: 0,
      filter: "name LIKE 'p%'",
      orderBy: { column: 'price', direction: 'desc' },
    });
    expect(page.result.rows.map((row) => row[1])).toEqual(['plum', 'pear']);
    expect(page.total).toBe(2);
    expect(page.keyColumns).toEqual(['id']);
  });

  it('runs statements one by one, stopping at the one that fails', async () => {
    const outcome = await run(
      "SELECT 1 AS one; UPDATE items SET price = 9 WHERE name = 'plum'; SELECT * FROM nope",
    );
    expect(outcome.results[0]?.rows).toEqual([[1]]);
    expect(outcome.results[1]?.affectedRows).toBe(1);
    expect(outcome.error?.statementIndex).toBe(2);
  });

  it('caps a big result', async () => {
    const outcome = await run('SELECT name FROM items ORDER BY id', false, 2);
    expect(outcome.results[0]?.rows).toHaveLength(2);
    expect(outcome.results[0]?.truncated).toBe(true);
  });

  it('refuses a write in a read-only run, then allows writes again', async () => {
    expect((await run("INSERT INTO items (name) VALUES ('x')", true)).error?.message).toMatch(
      /readonly|read-only|query_only/i,
    );
    expect((await run("INSERT INTO items (name) VALUES ('x')")).error).toBeUndefined();
  });

  it('applies row edits together, or none of them', async () => {
    const columns = (await driver.describe({ name: 'items' })).columns;
    const bad = buildRowEdits('sqlite', { name: 'items' }, columns, [
      { kind: 'update', key: { id: 1 }, values: { name: 'lost' } },
      { kind: 'update', key: { id: 2 }, values: { missing: 'x' } },
    ]);
    expect((await run(bad)).error).toBeDefined();
    expect((await run('SELECT name FROM items WHERE id = 1')).results[0]?.rows).toEqual([
      ['apple'],
    ]);
  });

  it('lists its pragmas as settings', async () => {
    const settings = (await driver.settings?.()) ?? [];
    expect(settings.find((setting) => setting.name === 'journal_mode')?.value).toBeTruthy();
    expect(settings.every((setting) => !setting.editable)).toBe(true);
  });

  it('draws its tables and foreign keys, filling in a key that names no column', async () => {
    await run(`
      CREATE TABLE orders (id INTEGER PRIMARY KEY, placed TEXT);
      CREATE TABLE order_items (
        order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        item_id INTEGER REFERENCES items,
        qty INT
      );
    `);
    const graph = await driver.schemaGraph?.({ database: null, schema: null });
    expect(graph?.tables.map((table) => table.ref.name)).toEqual([
      'items',
      'order_items',
      'orders',
    ]);
    expect(graph?.tables[1]?.columns[0]).toEqual({
      name: 'order_id',
      type: 'INTEGER',
      nullable: false,
      primaryKey: false,
    });
    expect(graph?.relations).toEqual([
      {
        name: 'order_items_item_id_fkey',
        from: { ref: { name: 'order_items' }, columns: ['item_id'] },
        to: { ref: { name: 'items' }, columns: ['id'] },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      },
      {
        name: 'order_items_order_id_fkey',
        from: { ref: { name: 'order_items' }, columns: ['order_id'] },
        to: { ref: { name: 'orders' }, columns: ['id'] },
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      },
    ]);
  });

  it('measures free pages, and a vacuum gives them back', async () => {
    await run(`
      CREATE TABLE junk (id INTEGER PRIMARY KEY, body TEXT);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
        INSERT INTO junk (body) SELECT printf('%.500c', 'x') FROM n;
      DELETE FROM junk;
    `);
    const before = await driver.health?.({ database: null, schema: null, scan: 'fast' });
    expect(before?.totalBytes).toBeGreaterThan(1_000_000);
    expect(before?.freeBytes).toBeGreaterThan(500_000);
    expect(before?.tables.length).toBeGreaterThan(0);
    const index = before?.indexes.find((one) => one.name === 'items_name');
    expect(index).toMatchObject({
      table: { name: 'items' },
      type: 'btree',
      columns: ['name'],
      unique: false,
      primary: false,
    });
    expect(before?.precise).toBe(true);

    expect((await run('VACUUM;')).error).toBeUndefined();
    const after = await driver.health?.({ database: null, schema: null, scan: 'fast' });
    expect(after?.freeBytes).toBe(0);
    expect(after?.totalBytes).toBeLessThan(before?.totalBytes ?? 0);
  });

  it('turns down a file that is not there', async () => {
    await expect(
      openDriver({
        engine: 'sqlite',
        host: '',
        port: null,
        file: join(tmpdir(), 'nope', 'x.db'),
        tls: false,
        srv: false,
      }),
    ).rejects.toThrow(/no file/);
  });
});

/**
 * Names, sorts, pages and edited values the app writes into its own SQL, sent through the driver
 * with the characters that would change a query if they were pasted in. Each has to come out as
 * plain data or a plain name: stored and read back as it was, matching only the rows that hold
 * it, and leaving every other row and table alone.
 */
describe('SQLite driver with hostile input', () => {
  const DROP = "'; DROP TABLE items; --";
  const ALWAYS = "' OR '1'='1";
  const NAME = 'x"; DROP TABLE items; --';
  const COLUMN = 'c`]"\'; DROP TABLE items; --';

  const itemNames = async () =>
    (await run('SELECT name FROM items ORDER BY id')).results[0]?.rows.map((row) => row[0]);

  it('browses a table whose name and column try to close their quotes', async () => {
    expect(
      (
        await run(
          `CREATE TABLE "x""; DROP TABLE items; --" (id INTEGER PRIMARY KEY, "c\`]""'; DROP TABLE items; --" TEXT);
           INSERT INTO "x""; DROP TABLE items; --" VALUES (1, 'one'), (2, 'two');`,
        )
      ).error,
    ).toBeUndefined();
    const nodes = await driver.listObjects(null, null);
    expect(nodes.map((node) => node.name)).toContain(NAME);
    const table = await driver.describe({ name: NAME });
    expect(table.columns.map((column) => column.name)).toEqual(['id', COLUMN]);
    const page = await driver.readRows({
      ref: { name: NAME },
      limit: 10,
      offset: 0,
      orderBy: { column: COLUMN, direction: 'desc' },
    });
    expect(page.result.rows).toEqual([
      [2, 'two'],
      [1, 'one'],
    ]);
    expect(page.total).toBe(2);
    expect(await itemNames()).toEqual(['apple', 'pear', 'plum']);
    const graph = await driver.schemaGraph?.({ database: null, schema: null });
    expect(graph?.tables.map((one) => one.ref.name)).toContain(NAME);
    expect(
      (await driver.health?.({ database: null, schema: null, scan: 'fast' }))?.tables,
    ).toHaveLength(2);
  });

  it('says a table that is only a hostile name is not there, and drops nothing', async () => {
    await expect(driver.describe({ name: `items${DROP}` })).rejects.toThrow(/no table/);
    await expect(
      driver.readRows({ ref: { name: `items"; DROP TABLE items; --` }, limit: 5, offset: 0 }),
    ).rejects.toThrow(/no table/);
    expect(await itemNames()).toEqual(['apple', 'pear', 'plum']);
  });

  it('sorts only ASC or DESC by a column the table has', async () => {
    const page = await driver.readRows({
      ref: { name: 'items' },
      limit: 5,
      offset: 0,
      orderBy: { column: 'price', direction: 'ASC; DROP TABLE items' as 'asc' },
    });
    expect(page.result.rows.map((row) => row[1])).toEqual(['apple', 'pear', 'plum']);
    await expect(
      driver.readRows({
        ref: { name: 'items' },
        limit: 5,
        offset: 0,
        orderBy: { column: 'price DESC; DROP TABLE items; --', direction: 'asc' },
      }),
    ).rejects.toThrow(/no column/);
    expect(await itemNames()).toEqual(['apple', 'pear', 'plum']);
  });

  it('turns down a page size or offset that is not a whole number', async () => {
    for (const bad of ['1; DROP TABLE items', 1.5, -1, Number.NaN] as unknown[]) {
      await expect(
        driver.readRows({ ref: { name: 'items' }, limit: bad as number, offset: 0 }),
      ).rejects.toThrow(/whole number/);
      await expect(
        driver.readRows({ ref: { name: 'items' }, limit: 5, offset: bad as number }),
      ).rejects.toThrow(/whole number/);
    }
    expect(await itemNames()).toEqual(['apple', 'pear', 'plum']);
  });

  it('keeps a typed filter inside its WHERE, and reads LIKE % and _ as the user escaped them', async () => {
    await expect(
      driver.readRows({
        ref: { name: 'items' },
        limit: 5,
        offset: 0,
        filter: '1=1); DROP TABLE items; --',
      }),
    ).rejects.toThrow(/one condition/);
    await expect(
      driver.readRows({
        ref: { name: 'items' },
        limit: 5,
        offset: 0,
        filter: '1=1) UNION SELECT 1, sql, 0 FROM sqlite_master --',
      }),
    ).rejects.toThrow(/one condition/);
    expect(await itemNames()).toEqual(['apple', 'pear', 'plum']);

    await run("INSERT INTO items (name) VALUES ('100%_done'), ('100xxdone')");
    const page = await driver.readRows({
      ref: { name: 'items' },
      limit: 5,
      offset: 0,
      filter: "name LIKE '100\\%\\_%' ESCAPE '\\'",
    });
    expect(page.result.rows.map((row) => row[1])).toEqual(['100%_done']);
  });

  it('applies edits with every value bound, matching only the rows they name', async () => {
    const columns = (await driver.describe({ name: 'items' })).columns;
    const statements = buildRowEditStatements('sqlite', { name: 'items' }, columns, [
      { kind: 'insert', values: { name: DROP } },
      { kind: 'insert', values: { name: ALWAYS, price: '1; DROP TABLE items' } },
      { kind: 'update', key: { id: 2 }, values: { name: `pear${DROP}` } },
      // A key that would match every row if it were pasted into the WHERE matches none.
      { kind: 'update', key: { id: ALWAYS }, values: { name: 'everyone' } },
      { kind: 'delete', key: { id: `3 OR 1=1` } },
      { kind: 'delete', key: { id: DROP } },
    ]);
    const outcome = await driver.applyEdits?.(statements, null);
    expect(outcome).toEqual({ affectedRows: 3 });
    expect((await run('SELECT id, name, price FROM items ORDER BY id')).results[0]?.rows).toEqual([
      [1, 'apple', 1.5],
      [2, `pear${DROP}`, 2],
      [3, 'plum', 3.25],
      [4, DROP, 0],
      [5, ALWAYS, '1; DROP TABLE items'],
    ]);
  });

  it('rolls every edit back when one of them fails', async () => {
    const columns = (await driver.describe({ name: 'items' })).columns;
    const statements = buildRowEditStatements('sqlite', { name: 'items' }, columns, [
      { kind: 'update', key: { id: 1 }, values: { name: DROP } },
      { kind: 'insert', values: { name: null } },
    ]);
    await expect(driver.applyEdits?.(statements, null)).rejects.toThrow(/NOT NULL/);
    expect(await itemNames()).toEqual(['apple', 'pear', 'plum']);
  });
});
