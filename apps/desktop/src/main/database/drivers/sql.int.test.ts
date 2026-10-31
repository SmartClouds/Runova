import { buildRowEdits, createUserStatements, dropUserStatement } from '@runova/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDriver } from './index';
import {
  dockerAvailable,
  imageUsable,
  startDatabase,
  type TestDatabase,
  waitFor,
} from './testing/containers';
import type { DbDriver, DriverConnectOptions } from './types';

/**
 * Every SQL driver against a real server in Docker: browsing, reading pages, running queries,
 * read-only runs and cancelling. The same checks run for each engine, so they behave alike in
 * the UI.
 */

interface SqlEngineCase {
  label: string;
  image: string;
  port: number;
  env: Record<string, string>;
  options: (db: TestDatabase) => DriverConnectOptions;
  /** Where the test table lives. */
  ref: { database?: string; schema?: string };
  database: string;
  createTable: string;
  sleep: string;
}

const CASES: SqlEngineCase[] = [
  {
    label: 'PostgreSQL',
    image: 'postgres:17-alpine',
    port: 5432,
    env: { POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'shop' },
    options: (db) => ({
      engine: 'postgres',
      host: db.host,
      port: db.port,
      user: 'postgres',
      password: 'pw',
      database: 'shop',
      tls: false,
      srv: false,
    }),
    ref: { database: 'shop', schema: 'public' },
    database: 'shop',
    createTable:
      'CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL, price numeric(8,2) DEFAULT 0, added timestamptz DEFAULT now())',
    sleep: 'SELECT pg_sleep(30)',
  },
  {
    label: 'MySQL',
    image: 'mysql:8.4',
    port: 3306,
    env: { MYSQL_ROOT_PASSWORD: 'pw', MYSQL_DATABASE: 'shop' },
    options: (db) => ({
      engine: 'mysql',
      host: db.host,
      port: db.port,
      user: 'root',
      password: 'pw',
      database: 'shop',
      tls: false,
      srv: false,
    }),
    ref: { database: 'shop' },
    database: 'shop',
    createTable:
      'CREATE TABLE items (id int AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL, price decimal(8,2) DEFAULT 0, added datetime DEFAULT CURRENT_TIMESTAMP)',
    sleep: 'SELECT SLEEP(30)',
  },
  {
    label: 'MariaDB',
    image: 'mariadb:11',
    port: 3306,
    env: { MARIADB_ROOT_PASSWORD: 'pw', MARIADB_DATABASE: 'shop' },
    options: (db) => ({
      engine: 'mariadb',
      host: db.host,
      port: db.port,
      user: 'root',
      password: 'pw',
      database: 'shop',
      tls: false,
      srv: false,
    }),
    ref: { database: 'shop' },
    database: 'shop',
    createTable:
      'CREATE TABLE items (id int AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL, price decimal(8,2) DEFAULT 0, added datetime DEFAULT CURRENT_TIMESTAMP)',
    sleep: 'SELECT SLEEP(30)',
  },
];

const enabled = dockerAvailable();

function run(
  driver: DbDriver,
  text: string,
  overrides: { readOnly?: boolean; maxRows?: number } = {},
) {
  return driver.query(text, {
    maxRows: overrides.maxRows ?? 1000,
    readOnly: overrides.readOnly ?? false,
    signal: new AbortController().signal,
  });
}

for (const engine of CASES) {
  describe.skipIf(!enabled || !imageUsable(engine.image))(`${engine.label} driver`, () => {
    let db: TestDatabase;
    let driver: DbDriver;
    const ref = { ...engine.ref, name: 'items' };

    beforeAll(async () => {
      db = startDatabase({ image: engine.image, port: engine.port, env: engine.env });
      driver = await waitFor(() => openDriver(engine.options(db)), 180_000);
      const created = await run(driver, engine.createTable);
      expect(created.error).toBeUndefined();
      const filled = await run(
        driver,
        "INSERT INTO items (name, price) VALUES ('apple', 1.5), ('pear', 2), ('plum', 3.25)",
      );
      expect(filled.error).toBeUndefined();
    }, 240_000);

    afterAll(async () => {
      await driver?.close();
      db?.remove();
    });

    it('says which version the server runs', async () => {
      expect(await driver.serverVersion()).toMatch(/\d+\.\d+/);
    });

    it('lists the databases, then what is inside one, down to the table', async () => {
      const top = await driver.listObjects(null, null);
      const shop = top.find((node) => node.name === engine.database);
      expect(shop).toMatchObject({ kind: 'database', hasChildren: true });

      let parent = shop;
      if (engine.ref.schema) {
        const schemas = await driver.listObjects(
          { name: engine.database, database: engine.database },
          'database',
        );
        parent = schemas.find((node) => node.name === engine.ref.schema);
        expect(parent).toMatchObject({ kind: 'schema' });
      }
      const tables = await driver.listObjects(parent?.ref ?? null, parent?.kind ?? null);
      expect(tables.find((node) => node.name === 'items')).toMatchObject({
        kind: 'table',
        ref,
        hasChildren: false,
      });
    });

    it('describes the table: columns, the primary key and its index', async () => {
      const table = await driver.describe(ref);
      expect(table.columns.map((column) => column.name)).toEqual(['id', 'name', 'price', 'added']);
      expect(table.columns[0]).toMatchObject({
        primaryKey: true,
        generated: true,
        nullable: false,
      });
      expect(table.columns[1]).toMatchObject({ primaryKey: false, nullable: false });
      expect(table.columns[2]?.defaultValue).toMatch(/0/);
      expect(table.indexes.some((index) => index.primary && index.columns.join() === 'id')).toBe(
        true,
      );
    });

    it('reads a page of rows, sorted and filtered, with the key columns for editing', async () => {
      const page = await driver.readRows({
        ref,
        limit: 2,
        offset: 0,
        orderBy: { column: 'price', direction: 'desc' },
      });
      expect(page.keyColumns).toEqual(['id']);
      expect(page.result.columns.map((column) => column.name)).toEqual([
        'id',
        'name',
        'price',
        'added',
      ]);
      expect(page.result.rows.map((row) => row[1])).toEqual(['plum', 'pear']);
      expect(page.total).toBe(3);

      const filtered = await driver.readRows({
        ref,
        limit: 10,
        offset: 0,
        filter: "name LIKE 'p%'",
      });
      expect(filtered.result.rows).toHaveLength(2);
    });

    it('runs several statements and gives back one result for each', async () => {
      const outcome = await run(
        driver,
        "SELECT 1 AS one; UPDATE items SET price = 4 WHERE name = 'plum'; SELECT name FROM items ORDER BY id",
      );
      expect(outcome.error).toBeUndefined();
      expect(outcome.results).toHaveLength(3);
      expect(outcome.results[0]?.rows).toEqual([[1]]);
      expect(outcome.results[1]?.affectedRows).toBe(1);
      expect(outcome.results[2]?.rows).toEqual([['apple'], ['pear'], ['plum']]);
    });

    it('stops at the statement that fails, keeping what ran before it', async () => {
      const outcome = await run(driver, 'SELECT 2 AS two; SELECT * FROM missing_table; SELECT 3');
      expect(outcome.results).toHaveLength(1);
      expect(outcome.error?.statementIndex).toBe(1);
      expect(outcome.error?.message).toMatch(/missing_table/);
    });

    it('applies row edits all together, or none of them when one fails', async () => {
      const columns = (await driver.describe(ref)).columns;
      const good = buildRowEdits(engine.options(db).engine, ref, columns, [
        { kind: 'update', key: { id: 1 }, values: { name: 'apple2' } },
        { kind: 'insert', values: { name: 'kiwi', price: '9' } },
      ]);
      expect((await run(driver, good)).error).toBeUndefined();
      const names = await run(driver, 'SELECT name FROM items ORDER BY id');
      expect(names.results[0]?.rows.map((row) => row[0])).toEqual([
        'apple2',
        'pear',
        'plum',
        'kiwi',
      ]);

      const bad = buildRowEdits(engine.options(db).engine, ref, columns, [
        { kind: 'update', key: { id: 1 }, values: { name: 'lost' } },
        { kind: 'update', key: { id: 2 }, values: { missing_column: 'x' } },
      ]);
      expect((await run(driver, bad)).error).toBeDefined();
      const after = await run(driver, 'SELECT name FROM items WHERE id = 1');
      expect(after.results[0]?.rows).toEqual([['apple2']]);
      await run(
        driver,
        "UPDATE items SET name = 'apple' WHERE id = 1; DELETE FROM items WHERE name = 'kiwi'",
      );
    });

    it('lists the server settings and the users, and creates a user with read access', async () => {
      const settings = (await driver.settings?.()) ?? [];
      expect(settings.length).toBeGreaterThan(50);
      expect(settings.some((setting) => /max_connections/.test(setting.name))).toBe(true);

      const engineName = engine.options(db).engine;
      const statements = createUserStatements(engineName, {
        user: 'reporter',
        password: 'Rep0rter!',
        database: 'shop',
        level: 'read',
      });
      const created = await run(driver, statements.join('\n'));
      expect(created.error).toBeUndefined();
      const users = (await driver.users?.()) ?? [];
      const reporter = users.find((user) => user.name === 'reporter');
      expect(reporter).toBeDefined();
      expect(reporter?.superuser).toBe(false);
      if (engineName !== 'postgres') {
        expect(reporter?.access).toEqual([{ database: 'shop', level: 'read' }]);
      }

      const reporterDriver = await openDriver({
        ...engine.options(db),
        user: 'reporter',
        password: 'Rep0rter!',
      });
      try {
        expect(
          (await run(reporterDriver, 'SELECT name FROM items WHERE id = 1')).error,
        ).toBeUndefined();
        expect(
          (await run(reporterDriver, "UPDATE items SET name = 'x' WHERE id = 1")).error,
        ).toBeDefined();
      } finally {
        await reporterDriver.close();
      }
      await run(
        driver,
        dropUserStatement(engineName, { user: 'reporter' }) + (engineName === 'postgres' ? '' : ''),
      );
    });

    it('caps a big result and says there was more', async () => {
      const outcome = await run(driver, 'SELECT name FROM items ORDER BY id', { maxRows: 2 });
      expect(outcome.results[0]?.rows).toHaveLength(2);
      expect(outcome.results[0]?.truncated).toBe(true);
    });

    it('refuses a write in a read-only run, and allows writes again afterwards', async () => {
      const blocked = await run(driver, "INSERT INTO items (name) VALUES ('sneaky')", {
        readOnly: true,
      });
      expect(blocked.error?.message).toMatch(/read.only/i);
      const allowed = await run(driver, "INSERT INTO items (name) VALUES ('fine')");
      expect(allowed.error).toBeUndefined();
      await run(driver, "DELETE FROM items WHERE name = 'fine'");
    });

    it('stops a long query when asked', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = driver.query(engine.sleep, {
        maxRows: 10,
        readOnly: true,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 500);
      const outcome = await pending;
      expect(outcome.cancelled).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
      // The connection still works after a cancel.
      expect((await run(driver, 'SELECT 5 AS five')).results[0]?.rows).toEqual([[5]]);
    }, 20_000);

    it('reports a refused password as such', async () => {
      await expect(openDriver({ ...engine.options(db), password: 'wrong' })).rejects.toMatchObject({
        authFailed: true,
      });
    });
  });
}
