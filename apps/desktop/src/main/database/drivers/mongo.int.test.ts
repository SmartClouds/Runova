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
 * The Mongo driver against a real server: browsing, inferred fields, paging with a filter, and
 * mongosh commands (reads, writes, and a read-only run that refuses a write).
 */

const IMAGE = 'mongo:7';
const enabled = dockerAvailable() && imageUsable(IMAGE);

const run = (driver: DbDriver, text: string, readOnly = false) =>
  driver.query(text, {
    maxRows: 100,
    readOnly,
    signal: new AbortController().signal,
    database: 'shop',
  });

describe.skipIf(!enabled)('MongoDB driver', () => {
  let db: TestDatabase;
  let driver: DbDriver;
  let options: DriverConnectOptions;

  beforeAll(async () => {
    db = startDatabase({
      image: IMAGE,
      port: 27017,
      env: { MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: 'mongo-secret' },
    });
    options = {
      engine: 'mongodb',
      host: db.host,
      port: db.port,
      user: 'admin',
      password: 'mongo-secret',
      authDatabase: 'admin',
      database: 'shop',
      tls: false,
      srv: false,
    };
    driver = await waitFor(() => openDriver(options), 180_000);
    const filled = await run(
      driver,
      'db.orders.insertMany([{ customer: "Ada", total: 12.5 }, { customer: "Grace", total: 40, vip: true }, { customer: "Linus", total: 3 }])',
    );
    expect(filled.error).toBeUndefined();
  }, 240_000);

  afterAll(async () => {
    await driver?.close();
    db?.remove();
  });

  it('lists databases and collections', async () => {
    expect((await driver.listObjects(null, null)).some((node) => node.name === 'shop')).toBe(true);
    const collections = await driver.listObjects({ database: 'shop', name: 'shop' }, 'database');
    expect(collections).toEqual([
      expect.objectContaining({ kind: 'collection', name: 'orders', rowEstimate: 3 }),
    ]);
  });

  it('reads the fields of a collection from its documents', async () => {
    const table = await driver.describe({ database: 'shop', name: 'orders' });
    expect(table.columns.map((column) => column.name)).toEqual(['_id', 'customer', 'total', 'vip']);
    expect(table.columns.find((column) => column.name === 'vip')?.nullable).toBe(true);
    expect(table.indexes[0]).toMatchObject({ name: '_id_', primary: true });
  });

  it('pages documents with a shell-style filter and a sort', async () => {
    const page = await driver.readRows({
      ref: { database: 'shop', name: 'orders' },
      limit: 10,
      offset: 0,
      filter: '{ total: { $gt: 10 } }',
      orderBy: { column: 'total', direction: 'desc' },
    });
    expect(
      page.result.rows.map(
        (row) => row[page.result.columns.findIndex((c) => c.name === 'customer')],
      ),
    ).toEqual(['Grace', 'Ada']);
    expect(page.total).toBe(2);
    expect(page.keyColumns).toEqual(['_id']);
  });

  it('runs reads and writes, and refuses a write in a read-only run', async () => {
    expect((await run(driver, 'db.orders.countDocuments({ vip: true })')).results[0]?.rows).toEqual(
      [[1]],
    );
    expect(
      (await run(driver, 'db.orders.updateMany({ total: { $lt: 5 } }, { $set: { small: true } })'))
        .results[0]?.affectedRows,
    ).toBe(1);
    const blocked = await run(driver, 'db.orders.deleteMany({})', true);
    expect(blocked.error?.message).toMatch(/read-only/);
    expect((await run(driver, 'db.orders.estimatedDocumentCount()')).results[0]?.rows).toEqual([
      [3],
    ]);
  });

  it('reports a refused password as such', async () => {
    await expect(openDriver({ ...options, password: 'wrong' })).rejects.toMatchObject({
      authFailed: true,
    });
  });
});
