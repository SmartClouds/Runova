import { parseMongoShell } from '@runova/core';
import { BSON } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { type MongoClientLike, type MongoCursorLike, runMongoCommand } from './mongoRun';

/**
 * Parsed mongosh commands mapped to driver calls, against a fake driver: what each method turns
 * into, how results become grid rows, and what a read-only run refuses.
 */

function cursor(docs: unknown[]) {
  const calls: { method: string; arg: unknown }[] = [];
  const self: MongoCursorLike = {
    sort: (arg) => (calls.push({ method: 'sort', arg }), self),
    limit: (arg) => (calls.push({ method: 'limit', arg }), self),
    skip: (arg) => (calls.push({ method: 'skip', arg }), self),
    project: (arg) => (calls.push({ method: 'project', arg }), self),
    hint: (arg) => (calls.push({ method: 'hint', arg }), self),
    toArray: async () => docs,
    close: vi.fn(async () => undefined),
  };
  return { self, calls };
}

function fakeClient(docs: unknown[] = []) {
  const found = cursor(docs);
  const collection = {
    find: vi.fn(() => found.self),
    aggregate: vi.fn(() => found.self),
    findOne: vi.fn(async () => docs[0] ?? null),
    countDocuments: vi.fn(async () => 42),
    updateMany: vi.fn(async () => ({ acknowledged: true, matchedCount: 3, modifiedCount: 3 })),
    insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: 'x' })),
    deleteMany: vi.fn(async () => ({ acknowledged: true, deletedCount: 5 })),
    indexes: vi.fn(async () => [{ name: '_id_', key: { _id: 1 } }]),
  };
  const db = {
    collection: vi.fn(() => collection),
    command: vi.fn(async (body: Record<string, unknown>) => ({ ok: 1, ...body })),
    listCollections: vi.fn(() => ({
      toArray: async () => [{ name: 'orders' }, { name: 'audit' }],
    })),
    createCollection: vi.fn(async () => ({})),
    dropDatabase: vi.fn(async () => true),
  };
  const client: MongoClientLike = { db: vi.fn(() => db) };
  return { client, db, collection, found };
}

const options = {
  database: 'shop',
  maxRows: 2,
  readOnly: false,
  signal: new AbortController().signal,
};
const run = (client: MongoClientLike, text: string, overrides: Partial<typeof options> = {}) =>
  runMongoCommand(client, parseMongoShell(text), text, { ...options, ...overrides });

describe('runMongoCommand', () => {
  it('runs a find with its chain, capping rows and putting _id first', async () => {
    const id = new BSON.ObjectId('65f0c0ffee65f0c0ffee65f0');
    const { client, collection, found } = fakeClient([
      { name: 'Ada', _id: id, tags: ['x'] },
      { _id: 2, name: 'Grace', city: 'NYC' },
      { _id: 3 },
    ]);
    const { result } = await run(
      client,
      'db.users.find({ age: { $gt: 3 } }).sort({ name: 1 }).skip(10)',
    );
    expect(collection.find).toHaveBeenCalledWith({ age: { $gt: 3 } }, undefined);
    expect(found.calls).toEqual([
      { method: 'sort', arg: { name: 1 } },
      { method: 'skip', arg: 10 },
      { method: 'limit', arg: 3 },
    ]);
    expect(result.columns.map((column) => column.name)).toEqual(['_id', 'name', 'tags', 'city']);
    expect(result.rows).toEqual([
      [{ $oid: '65f0c0ffee65f0c0ffee65f0' }, 'Ada', ['x'], null],
      [2, 'Grace', null, 'NYC'],
    ]);
    expect(result.truncated).toBe(true);
  });

  it('turns ObjectId and dates in the filter into BSON', async () => {
    const { client, collection } = fakeClient();
    await run(
      client,
      'db.users.find({ _id: ObjectId("65f0c0ffee65f0c0ffee65f0"), at: { $gt: ISODate("2026-01-01") } })',
    );
    const filter = (collection.find.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(filter._id).toBeInstanceOf(BSON.ObjectId);
    expect((filter.at as { $gt: unknown }).$gt).toBeInstanceOf(Date);
  });

  it('counts the documents a write changed', async () => {
    const { client } = fakeClient();
    expect(
      (await run(client, 'db.users.updateMany({ a: 1 }, { $set: { b: 2 } })')).result.affectedRows,
    ).toBe(3);
    expect((await run(client, 'db.users.insertOne({ a: 1 })')).result.affectedRows).toBe(1);
    expect((await run(client, 'db.users.deleteMany({ old: true })')).result.affectedRows).toBe(5);
  });

  it('refuses writes in a read-only run', async () => {
    const { client, collection } = fakeClient();
    await expect(run(client, 'db.users.deleteMany({})', { readOnly: true })).rejects.toThrow(
      /read-only/,
    );
    expect(collection.deleteMany).not.toHaveBeenCalled();
    await expect(run(client, 'db.dropDatabase()', { readOnly: true })).rejects.toThrow(/read-only/);
  });

  it('shows collections, counts, and runs database commands', async () => {
    const { client, db } = fakeClient();
    expect((await run(client, 'show collections')).result.rows).toEqual([['audit'], ['orders']]);
    expect((await run(client, 'db.orders.find({}).count()')).result.rows).toEqual([[42]]);
    await run(client, 'db.createUser({ user: "app", pwd: "pw", roles: [] })');
    expect(db.command).toHaveBeenCalledWith({ createUser: 'app', pwd: 'pw', roles: [] });
  });

  it('moves the session database with use', async () => {
    const { client } = fakeClient();
    expect((await run(client, 'use blog')).database).toBe('blog');
  });

  it('says plainly what it cannot run', async () => {
    const { client } = fakeClient();
    await expect(run(client, 'db.users.mapReduce({})')).rejects.toThrow(
      /not something Runova can run/,
    );
    await expect(run(client, 'db.users.find().forEach({})')).rejects.toThrow(/not supported/);
  });
});
