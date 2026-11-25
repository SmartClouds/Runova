import { randomBytes } from 'node:crypto';
import {
  buildRowEditStatements,
  maintenanceActions,
  maintenanceStatements,
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
 * SQL Server and Cassandra against real servers, where their images can be pulled (CI). Both
 * take a while to start, so each waits up to a few minutes.
 *
 * SQL Server can also run against one already installed: set RUNOVA_TEST_MSSQL_HOST, _PORT, _USER
 * and _PASSWORD (a login that can create databases). The test then makes its own database with a
 * random name and drops it at the end.
 */

const MSSQL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
const CASSANDRA_IMAGE = 'cassandra:5';

const EXISTING_MSSQL: DriverConnectOptions | null = process.env.RUNOVA_TEST_MSSQL_HOST
  ? {
      engine: 'mssql',
      host: process.env.RUNOVA_TEST_MSSQL_HOST,
      port: Number(process.env.RUNOVA_TEST_MSSQL_PORT ?? 1433),
      user: process.env.RUNOVA_TEST_MSSQL_USER,
      password: process.env.RUNOVA_TEST_MSSQL_PASSWORD,
      database: 'master',
      tls: false,
      srv: false,
    }
  : null;
const MSSQL_DB = EXISTING_MSSQL ? `runova_test_${randomBytes(4).toString('hex')}` : 'shop';

const run = (driver: DbDriver, text: string, readOnly = false, database?: string) =>
  driver.query(text, {
    maxRows: 100,
    readOnly,
    signal: new AbortController().signal,
    database: database ?? null,
  });

describe.skipIf(!EXISTING_MSSQL && (!dockerAvailable() || !imageUsable(MSSQL_IMAGE)))(
  'SQL Server driver',
  () => {
    let db: TestDatabase;
    let driver: DbDriver;
    let options: DriverConnectOptions;

    beforeAll(async () => {
      if (EXISTING_MSSQL) {
        options = EXISTING_MSSQL;
        driver = await openDriver(options);
      } else {
        db = startDatabase({
          image: MSSQL_IMAGE,
          port: 1433,
          env: { ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: 'Runova-Str0ng!' },
        });
        options = {
          engine: 'mssql',
          host: db.host,
          port: db.port,
          user: 'sa',
          password: 'Runova-Str0ng!',
          database: 'master',
          tls: false,
          srv: false,
        };
        driver = await waitFor(() => openDriver(options), 300_000);
      }
      expect((await run(driver, `CREATE DATABASE [${MSSQL_DB}]`)).error).toBeUndefined();
      const setup = await run(
        driver,
        "CREATE TABLE dbo.items (id int IDENTITY PRIMARY KEY, name nvarchar(50) NOT NULL);\nINSERT INTO dbo.items (name) VALUES (N'apple'), (N'pear')",
        false,
        MSSQL_DB,
      );
      expect(setup.error).toBeUndefined();
    }, 360_000);

    afterAll(async () => {
      if (EXISTING_MSSQL && driver) {
        // A server that outlives the test keeps nothing of it.
        await run(
          driver,
          `ALTER DATABASE [${MSSQL_DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\nDROP DATABASE [${MSSQL_DB}]`,
          false,
          'master',
        );
      }
      await driver?.close();
      db?.remove();
    });

    it('browses databases, schemas and tables, and describes one', async () => {
      expect((await driver.listObjects(null, null)).some((node) => node.name === MSSQL_DB)).toBe(
        true,
      );
      const schemas = await driver.listObjects({ database: MSSQL_DB, name: MSSQL_DB }, 'database');
      expect(schemas.map((node) => node.name)).toContain('dbo');
      const tables = await driver.listObjects(
        { database: MSSQL_DB, schema: 'dbo', name: 'dbo' },
        'schema',
      );
      expect(tables).toEqual([
        expect.objectContaining({ kind: 'table', name: 'items', rowEstimate: 2 }),
      ]);
      const table = await driver.describe({ database: MSSQL_DB, schema: 'dbo', name: 'items' });
      expect(table.columns[0]).toMatchObject({ name: 'id', primaryKey: true, generated: true });
    });

    it('pages rows, and keeps nothing a read-only run writes', async () => {
      const page = await driver.readRows({
        ref: { database: MSSQL_DB, schema: 'dbo', name: 'items' },
        limit: 10,
        offset: 0,
      });
      expect(page.result.rows.map((row) => row[1])).toEqual(['apple', 'pear']);
      await run(driver, "INSERT INTO dbo.items (name) VALUES (N'sneaky')", true, MSSQL_DB);
      expect(
        (await run(driver, 'SELECT COUNT(*) AS n FROM dbo.items', false, MSSQL_DB)).results[0]
          ?.rows,
      ).toEqual([[2]]);
    });

    it('treats hostile names and values in its own SQL as names and data', async () => {
      const ref = { database: MSSQL_DB, schema: 'dbo', name: 'x]; DROP TABLE dbo.items; --' };
      const column = 'c]"\'; DROP TABLE dbo.items; --';
      const created = await run(
        driver,
        `CREATE TABLE ${qualifiedName('mssql', ref)} (id bigint PRIMARY KEY, ${quoteIdentifier('mssql', column)} nvarchar(200), flag bit)`,
        false,
        MSSQL_DB,
      );
      expect(created.error).toBeUndefined();
      const values = [
        "'; DROP TABLE dbo.items; --",
        "' OR '1'='1",
        "N'x' + N'y'",
        '100%_done',
        'é ü',
      ];
      try {
        const table = await driver.describe(ref);
        expect(table.columns.map((one) => one.name)).toEqual(['id', column, 'flag']);
        const inserts = buildRowEditStatements(
          'mssql',
          table.ref,
          table.columns,
          values.map((value, index) => ({
            kind: 'insert' as const,
            values: {
              id: String(9_007_199_254_740_993n + BigInt(index)),
              [column]: value,
              flag: index % 2 === 0,
            },
          })),
        );
        expect(await driver.applyEdits?.(inserts, null)).toEqual({ affectedRows: values.length });
        const update = buildRowEditStatements('mssql', table.ref, table.columns, [
          { kind: 'update', key: { [column]: "' OR '1'='1" }, values: { [column]: 'matched' } },
          { kind: 'delete', key: { [column]: "nothing' OR '1'='1" } },
        ]);
        expect(await driver.applyEdits?.(update, null)).toEqual({ affectedRows: 1 });
        const page = await driver.readRows({
          ref,
          limit: 50,
          offset: 0,
          orderBy: { column: 'id', direction: 'asc' },
        });
        expect(page.result.rows.map((row) => [row[0], row[1], row[2]])).toEqual(
          values.map((value, index) => [
            String(9_007_199_254_740_993n + BigInt(index)),
            value === "' OR '1'='1" ? 'matched' : value,
            index % 2 === 0,
          ]),
        );
        await expect(
          driver.readRows({
            ref,
            limit: 5,
            offset: 0,
            filter: '1=1) COMMIT DROP TABLE dbo.items SELECT 1 WHERE (1=1',
          }),
        ).rejects.toThrow(/one condition/);
        // A hostile schema is a value to look up, and matches no schema.
        await expect(
          driver.describe({ database: MSSQL_DB, schema: "dbo' OR '1'='1", name: 'items' }),
        ).rejects.toThrow(/no table/);
      } finally {
        await run(driver, `DROP TABLE ${qualifiedName('mssql', ref)}`, false, MSSQL_DB);
      }
      expect(
        (await run(driver, 'SELECT name FROM dbo.items ORDER BY id', false, MSSQL_DB)).results[0]
          ?.rows,
      ).toEqual([['apple'], ['pear']]);
    });

    it('reports a refused password as such', async () => {
      await expect(openDriver({ ...options, password: 'wrong' })).rejects.toMatchObject({
        authFailed: true,
      });
    });

    it('reads the tables and foreign keys the diagram draws', async () => {
      const setup = await run(
        driver,
        'CREATE TABLE dbo.notes (id int IDENTITY PRIMARY KEY, item_id int NULL, body nvarchar(max), CONSTRAINT FK_notes_items FOREIGN KEY (item_id) REFERENCES dbo.items (id) ON DELETE SET NULL);\nCREATE TABLE dbo.log (at datetime2 NOT NULL, line nvarchar(200));\nCREATE INDEX IX_notes_item ON dbo.notes (item_id)',
        false,
        MSSQL_DB,
      );
      expect(setup.error).toBeUndefined();
      const graph = await driver.schemaGraph?.({ database: MSSQL_DB, schema: 'dbo' });
      expect(graph?.tables.map((table) => table.ref.name)).toEqual(['items', 'log', 'notes']);
      expect(graph?.tables[2]?.columns.map((column) => column.type)).toEqual([
        'int',
        'int',
        'nvarchar(max)',
      ]);
      expect(graph?.relations).toEqual([
        {
          name: 'FK_notes_items',
          from: { ref: { database: MSSQL_DB, schema: 'dbo', name: 'notes' }, columns: ['item_id'] },
          to: { ref: { database: MSSQL_DB, schema: 'dbo', name: 'items' }, columns: ['id'] },
          onDelete: 'SET NULL',
          onUpdate: 'NO ACTION',
        },
      ]);
    });

    it('reads fragmentation of clustered, nonclustered and heap, and rebuilds and reorganizes', async () => {
      for (const scan of ['fast', 'thorough'] as const) {
        const report = await driver.health?.({ database: MSSQL_DB, schema: null, scan });
        const types = new Set(report?.indexes.map((index) => index.type));
        expect(types).toEqual(new Set(['clustered', 'nonclustered', 'heap']));
        expect(report?.totalBytes).toBeGreaterThan(0);
        expect(report?.tables.map((table) => table.table.name)).toContain('items');
      }
      const items = { database: MSSQL_DB, schema: 'dbo', name: 'items' };
      const notes = { database: MSSQL_DB, schema: 'dbo', name: 'notes' };
      const statements = [
        ...maintenanceStatements('mssql', 'reorganize', {
          scope: 'index',
          table: notes,
          index: 'IX_notes_item',
        }),
        ...maintenanceStatements(
          'mssql',
          'rebuild',
          { scope: 'index', table: notes, index: 'IX_notes_item' },
          { fillFactor: 90, sortInTempdb: true },
        ),
        ...maintenanceStatements('mssql', 'rebuild', { scope: 'table', table: items }),
        ...maintenanceStatements('mssql', 'reorganize', { scope: 'table', table: items }),
        ...maintenanceStatements('mssql', 'statistics', { scope: 'table', table: items }),
        ...maintenanceStatements('mssql', 'rebuild', {
          scope: 'heap',
          table: { database: MSSQL_DB, schema: 'dbo', name: 'log' },
        }),
        ...maintenanceStatements('mssql', 'statistics', { scope: 'database' }),
      ];
      const report = await driver.health?.({ database: MSSQL_DB, schema: null, scan: 'fast' });
      if (report?.onlineRebuild) {
        statements.push(
          ...maintenanceStatements(
            'mssql',
            'rebuild',
            { scope: 'index', table: notes, index: 'IX_notes_item' },
            { online: true },
          ),
          ...maintenanceStatements(
            'mssql',
            'rebuild',
            { scope: 'heap', table: { database: MSSQL_DB, schema: 'dbo', name: 'log' } },
            { online: true },
          ),
        );
      }
      expect(maintenanceActions('mssql', 'index').length).toBeGreaterThan(0);
      for (const statement of statements) {
        const outcome = await run(driver, statement, false, MSSQL_DB);
        expect(outcome.error, statement).toBeUndefined();
      }
    }, 120_000);
  },
);

describe.skipIf(!dockerAvailable() || !imageUsable(CASSANDRA_IMAGE))('Cassandra driver', () => {
  let db: TestDatabase;
  let driver: DbDriver;

  beforeAll(async () => {
    db = startDatabase({ image: CASSANDRA_IMAGE, port: 9042 });
    driver = await waitFor(
      () =>
        openDriver({ engine: 'cassandra', host: db.host, port: db.port, tls: false, srv: false }),
      300_000,
    );
    const setup = await run(
      driver,
      "CREATE KEYSPACE shop WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};\nCREATE TABLE shop.items (id int PRIMARY KEY, name text);\nINSERT INTO shop.items (id, name) VALUES (1, 'apple');\nINSERT INTO shop.items (id, name) VALUES (2, 'pear')",
    );
    expect(setup.error).toBeUndefined();
  }, 360_000);

  afterAll(async () => {
    await driver?.close();
    db?.remove();
  });

  it('lists keyspaces and tables, and describes the key', async () => {
    expect((await driver.listObjects(null, null))[0]?.name).toBe('shop');
    const tables = await driver.listObjects({ database: 'shop', name: 'shop' }, 'database');
    expect(tables.map((node) => node.name)).toEqual(['items']);
    const table = await driver.describe({ database: 'shop', name: 'items' });
    expect(table.columns[0]).toMatchObject({ name: 'id', primaryKey: true });
  });

  it('reads rows and refuses a write in a read-only run', async () => {
    const page = await driver.readRows({
      ref: { database: 'shop', name: 'items' },
      limit: 10,
      offset: 0,
    });
    expect(page.result.rows).toHaveLength(2);
    expect(
      (await run(driver, "INSERT INTO shop.items (id, name) VALUES (3, 'x')", true)).error?.message,
    ).toMatch(/read-only/);
  });
});
