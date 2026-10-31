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
 */

const MSSQL_IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
const CASSANDRA_IMAGE = 'cassandra:5';

const run = (driver: DbDriver, text: string, readOnly = false, database?: string) =>
  driver.query(text, {
    maxRows: 100,
    readOnly,
    signal: new AbortController().signal,
    database: database ?? null,
  });

describe.skipIf(!dockerAvailable() || !imageUsable(MSSQL_IMAGE))('SQL Server driver', () => {
  let db: TestDatabase;
  let driver: DbDriver;
  let options: DriverConnectOptions;

  beforeAll(async () => {
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
    expect((await run(driver, 'CREATE DATABASE shop')).error).toBeUndefined();
    const setup = await run(
      driver,
      "CREATE TABLE dbo.items (id int IDENTITY PRIMARY KEY, name nvarchar(50) NOT NULL);\nINSERT INTO dbo.items (name) VALUES (N'apple'), (N'pear')",
      false,
      'shop',
    );
    expect(setup.error).toBeUndefined();
  }, 360_000);

  afterAll(async () => {
    await driver?.close();
    db?.remove();
  });

  it('browses databases, schemas and tables, and describes one', async () => {
    expect((await driver.listObjects(null, null)).some((node) => node.name === 'shop')).toBe(true);
    const schemas = await driver.listObjects({ database: 'shop', name: 'shop' }, 'database');
    expect(schemas.map((node) => node.name)).toContain('dbo');
    const tables = await driver.listObjects(
      { database: 'shop', schema: 'dbo', name: 'dbo' },
      'schema',
    );
    expect(tables).toEqual([
      expect.objectContaining({ kind: 'table', name: 'items', rowEstimate: 2 }),
    ]);
    const table = await driver.describe({ database: 'shop', schema: 'dbo', name: 'items' });
    expect(table.columns[0]).toMatchObject({ name: 'id', primaryKey: true, generated: true });
  });

  it('pages rows, and keeps nothing a read-only run writes', async () => {
    const page = await driver.readRows({
      ref: { database: 'shop', schema: 'dbo', name: 'items' },
      limit: 10,
      offset: 0,
    });
    expect(page.result.rows.map((row) => row[1])).toEqual(['apple', 'pear']);
    await run(driver, "INSERT INTO dbo.items (name) VALUES (N'sneaky')", true, 'shop');
    expect(
      (await run(driver, 'SELECT COUNT(*) AS n FROM dbo.items', false, 'shop')).results[0]?.rows,
    ).toEqual([[2]]);
  });

  it('reports a refused password as such', async () => {
    await expect(openDriver({ ...options, password: 'wrong' })).rejects.toMatchObject({
      authFailed: true,
    });
  });
});

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
