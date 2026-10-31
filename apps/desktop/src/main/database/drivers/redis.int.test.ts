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
 * The Redis driver against a real server: databases and keys, a key's contents by type, commands
 * typed like redis-cli, and a read-only run that refuses a write.
 */

const IMAGE = 'redis:8-alpine';
const enabled = dockerAvailable() && imageUsable(IMAGE);

describe.skipIf(!enabled)('Redis driver', () => {
  let db: TestDatabase;
  let driver: DbDriver;
  let options: DriverConnectOptions;
  const run = (text: string, readOnly = false) =>
    driver.query(text, { maxRows: 100, readOnly, signal: new AbortController().signal });

  beforeAll(async () => {
    db = startDatabase({
      image: IMAGE,
      port: 6379,
      args: ['redis-server', '--requirepass', 'redis-secret'],
    });
    options = {
      engine: 'redis',
      host: db.host,
      port: db.port,
      password: 'redis-secret',
      tls: false,
      srv: false,
    };
    driver = await waitFor(() => openDriver(options), 120_000);
    const seeded = await run(
      [
        'SET greeting "hello world"',
        'HSET user:1 name Ada city London',
        'RPUSH queue a b c',
        'SADD tags red green',
        'ZADD scores 10 ada 20 grace',
      ].join('\n'),
    );
    expect(seeded.error).toBeUndefined();
  }, 180_000);

  afterAll(async () => {
    await driver?.close();
    db?.remove();
  });

  it('lists the databases with keys, then the keys with their types', async () => {
    const top = await driver.listObjects(null, null);
    expect(top[0]).toMatchObject({ kind: 'database', name: 'db0', rowEstimate: 5 });
    const keys = await driver.listObjects(top[0]?.ref ?? null, 'database');
    expect(keys.map((key) => [key.name, key.detail])).toEqual([
      ['greeting', 'string'],
      ['queue', 'list'],
      ['scores', 'zset'],
      ['tags', 'set'],
      ['user:1', 'hash'],
    ]);
    expect(
      (await driver.listObjects(top[0]?.ref ?? null, 'database', 'user:*')).map((key) => key.name),
    ).toEqual(['user:1']);
  });

  it('shows each type of key as rows', async () => {
    const read = (name: string) =>
      driver.readRows({ ref: { database: '0', name }, limit: 10, offset: 0 });
    expect((await read('greeting')).result.rows).toEqual([['hello world']]);
    expect((await read('user:1')).result.rows).toEqual([
      ['name', 'Ada'],
      ['city', 'London'],
    ]);
    expect((await read('queue')).result.rows).toEqual([
      [0, 'a'],
      [1, 'b'],
      [2, 'c'],
    ]);
    expect((await read('scores')).result.rows).toEqual([
      ['ada', 10],
      ['grace', 20],
    ]);
    expect((await driver.describe({ database: '0', name: 'queue' })).rowEstimate).toBe(3);
  });

  it('runs commands, and refuses a write in a read-only run', async () => {
    expect((await run('GET greeting')).results[0]?.rows).toEqual([['hello world']]);
    expect((await run('DEL greeting', true)).error?.message).toMatch(/read-only/);
    expect((await run('EXISTS greeting')).results[0]?.rows).toEqual([[1]]);
  });

  it('lists the config and the ACL users', async () => {
    expect((await driver.settings?.())?.some((setting) => setting.name === 'maxmemory')).toBe(true);
    expect((await driver.users?.())?.[0]).toMatchObject({ name: 'default', superuser: true });
  });

  it('reports a refused password as such', async () => {
    await expect(openDriver({ ...options, password: 'wrong' })).rejects.toMatchObject({
      authFailed: true,
    });
  });
});
