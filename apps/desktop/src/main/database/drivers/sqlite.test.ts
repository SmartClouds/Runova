import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRowEdits } from '@runova/core';
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
