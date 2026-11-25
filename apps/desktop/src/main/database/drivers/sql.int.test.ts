import {
  buildRowEditStatements,
  buildRowEdits,
  createUserStatements,
  type DbEngine,
  dropUserStatement,
  maintenanceActions,
  maintenanceStatements,
  PRECISE_STATS_STATEMENT,
  qualifiedName,
  quoteIdentifier,
} from '@runova/core';
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
  engine: DbEngine;
  image: string;
  port: number;
  env: Record<string, string>;
  options: (db: TestDatabase) => DriverConnectOptions;
  /** Where the test table lives. */
  ref: { database?: string; schema?: string };
  database: string;
  createTable: string;
  /** A table with a foreign key to items, for the diagram. */
  relatedTable: string;
  sleep: string;
}

const CASES: SqlEngineCase[] = [
  {
    label: 'PostgreSQL',
    engine: 'postgres',
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
    relatedTable:
      'CREATE TABLE item_notes (id serial PRIMARY KEY, item_id int NOT NULL REFERENCES items (id) ON DELETE CASCADE, body text)',
    sleep: 'SELECT pg_sleep(30)',
  },
  {
    label: 'MySQL',
    engine: 'mysql',
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
    relatedTable:
      'CREATE TABLE item_notes (id int AUTO_INCREMENT PRIMARY KEY, item_id int NOT NULL, body text, CONSTRAINT fk_notes_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE)',
    sleep: 'SELECT SLEEP(30)',
  },
  {
    label: 'MariaDB',
    engine: 'mariadb',
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
    relatedTable:
      'CREATE TABLE item_notes (id int AUTO_INCREMENT PRIMARY KEY, item_id int NOT NULL, body text, CONSTRAINT fk_notes_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE)',
    sleep: 'SELECT SLEEP(30)',
  },
];

const enabled = dockerAvailable();

/** Values that would change a statement if they were pasted into its text. */
const HOSTILE_VALUES = [
  "'; DROP TABLE items; --",
  "' OR '1'='1",
  "\\'; DROP TABLE items; --",
  "x' OR 1=1; --",
  '100%_done',
  "it''s",
  'back\\slash',
];

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

    it('treats hostile names and values in its own SQL as names and data', async () => {
      const name =
        engine.engine === 'postgres' ? 'x"; DROP TABLE items; --' : 'x`; DROP TABLE items; --';
      const column = 'c`"\'; DROP TABLE items; --';
      const hostileRef = { ...engine.ref, name };
      const created = await run(
        driver,
        `CREATE TABLE ${qualifiedName(engine.engine, hostileRef)} (id int PRIMARY KEY, ${quoteIdentifier(engine.engine, column)} varchar(200))`,
      );
      expect(created.error).toBeUndefined();
      try {
        const table = await driver.describe(hostileRef);
        expect(table.columns.map((one) => one.name)).toEqual(['id', column]);
        expect(table.columns[0]?.primaryKey).toBe(true);

        const values = HOSTILE_VALUES;
        const inserts = buildRowEditStatements(
          engine.engine,
          table.ref,
          table.columns,
          values.map((value, index) => ({
            kind: 'insert' as const,
            values: { id: index + 1, [column]: value },
          })),
        );
        expect(await driver.applyEdits?.(inserts, engine.database)).toEqual({
          affectedRows: values.length,
        });
        // A key that would match every row if it were pasted in matches the one row holding it.
        const update = buildRowEditStatements(engine.engine, table.ref, table.columns, [
          { kind: 'update', key: { [column]: "' OR '1'='1" }, values: { [column]: 'matched' } },
          { kind: 'delete', key: { [column]: "nothing' OR '1'='1" } },
        ]);
        expect(await driver.applyEdits?.(update, engine.database)).toEqual({ affectedRows: 1 });

        const page = await driver.readRows({
          ref: hostileRef,
          limit: 50,
          offset: 0,
          orderBy: { column, direction: 'asc' },
        });
        expect(page.keyColumns).toEqual(['id']);
        const stored = values.map((value) => (value === "' OR '1'='1" ? 'matched' : value));
        expect(page.result.rows.map((row) => row[1]).sort()).toEqual([...stored].sort());
        await expect(
          driver.readRows({
            ref: hostileRef,
            limit: 50,
            offset: 0,
            orderBy: { column: `${column} DESC; DROP TABLE items; --`, direction: 'asc' },
          }),
        ).rejects.toThrow(/no column/);
        await expect(
          driver.readRows({ ref: hostileRef, limit: 50, offset: 0, filter: '1=1) OR (1=1' }),
        ).rejects.toThrow(/one condition/);
      } finally {
        await run(driver, `DROP TABLE ${qualifiedName(engine.engine, hostileRef)}`);
      }
      const items = await run(driver, 'SELECT name FROM items ORDER BY id');
      expect(items.results[0]?.rows).toEqual([['apple'], ['pear'], ['plum']]);
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

    it('reads the tables and foreign keys the diagram draws', async () => {
      expect((await run(driver, engine.relatedTable)).error).toBeUndefined();
      const graph = await driver.schemaGraph?.({
        database: engine.database,
        schema: engine.ref.schema ?? null,
      });
      expect(graph?.tables.map((table) => table.ref.name)).toEqual(
        expect.arrayContaining(['items', 'item_notes']),
      );
      const items = graph?.tables.find((table) => table.ref.name === 'items');
      expect(items?.columns[0]).toMatchObject({ name: 'id', primaryKey: true, nullable: false });
      expect(graph?.relations).toContainEqual(
        expect.objectContaining({
          from: { ref: expect.objectContaining({ name: 'item_notes' }), columns: ['item_id'] },
          to: { ref: expect.objectContaining({ name: 'items' }), columns: ['id'] },
          onDelete: 'CASCADE',
        }),
      );
    });

    it("measures index health and runs the engine's own clean-up", async () => {
      for (const scan of ['fast', 'thorough'] as const) {
        const report = await driver.health?.({
          database: engine.database,
          schema: engine.ref.schema ?? null,
          scan,
        });
        expect(report?.indexes.some((index) => index.table.name === 'items' && index.primary)).toBe(
          true,
        );
        expect(report?.tables.some((table) => table.table.name === 'items')).toBe(true);
        expect(report?.totalBytes).toBeGreaterThan(0);
      }
      const report = await driver.health?.({
        database: engine.database,
        schema: engine.ref.schema ?? null,
        scan: 'fast',
      });
      const primary = report?.indexes.find(
        (index) => index.table.name === 'items' && index.primary,
      );
      const table = ref;
      for (const one of maintenanceActions(engine.engine, 'table')) {
        const statements = maintenanceStatements(
          engine.engine,
          one.action,
          { scope: 'table', table },
          engine.engine === 'postgres' && one.action === 'rebuild' ? { concurrently: true } : {},
        );
        const outcome = await run(driver, statements.join('\n'));
        expect(outcome.error, `${one.label}: ${statements.join(' ')}`).toBeUndefined();
      }
      for (const one of maintenanceActions(engine.engine, 'index')) {
        const statements = maintenanceStatements(
          engine.engine,
          one.action,
          { scope: 'index', table, index: primary?.name ?? '' },
          engine.engine === 'postgres' ? { concurrently: true, fillFactor: 90 } : {},
        );
        const outcome = await run(driver, statements.join('\n'));
        expect(outcome.error, `${one.label}: ${statements.join(' ')}`).toBeUndefined();
      }
      for (const one of maintenanceActions(engine.engine, 'database')) {
        const statements = maintenanceStatements(engine.engine, one.action, { scope: 'database' });
        const outcome = await run(driver, statements.join('\n'));
        expect(outcome.error, `${one.label}: ${statements.join(' ')}`).toBeUndefined();
      }
      if (engine.engine === 'postgres') {
        // The official image ships pgstattuple: once added, a thorough scan is exact.
        expect(report?.canBePrecise).toBe(true);
        expect((await run(driver, PRECISE_STATS_STATEMENT)).error).toBeUndefined();
        const exact = await driver.health?.({
          database: engine.database,
          schema: 'public',
          scan: 'thorough',
        });
        expect(exact).toMatchObject({ precise: true, canBePrecise: false, method: 'pgstattuple' });
        const pk = exact?.indexes.find((index) => index.table.name === 'items' && index.primary);
        expect(pk?.fragmentationPercent).toEqual(expect.any(Number));
      }
    }, 60_000);
  });
}
