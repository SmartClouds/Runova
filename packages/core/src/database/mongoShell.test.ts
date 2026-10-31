import { describe, expect, it } from 'vitest';
import { parseMongoShell, parseMongoValue } from './mongoShell.js';

/**
 * Mongo queries are written the way mongosh takes them, but never run as JavaScript: they are
 * parsed into a collection, method calls and plain values (with Extended JSON markers for
 * ObjectId, dates and the like), and anything else is refused.
 */

describe('parseMongoValue', () => {
  it('reads JavaScript object literals: bare keys, single quotes, trailing commas', () => {
    expect(parseMongoValue("{ name: 'Ada', age: { $gt: 30 }, tags: ['a', \"b\",], }")).toEqual({
      name: 'Ada',
      age: { $gt: 30 },
      tags: ['a', 'b'],
    });
  });

  it('reads numbers, booleans, null and nested arrays', () => {
    expect(parseMongoValue('[1, -2.5, 1e3, true, false, null, [ ]]')).toEqual([
      1,
      -2.5,
      1000,
      true,
      false,
      null,
      [],
    ]);
  });

  it('turns ObjectId, ISODate, NumberLong, NumberDecimal and UUID into Extended JSON', () => {
    expect(
      parseMongoValue(
        '{ _id: ObjectId("65f0c0ffee65f0c0ffee65f0"), at: ISODate("2026-01-02T03:04:05Z"), n: NumberLong("9007199254740993"), d: NumberDecimal("1.10"), u: UUID("0f8fad5b-d9cb-469f-a165-70867728950e"), when: new Date("2026-01-01") }',
      ),
    ).toEqual({
      _id: { $oid: '65f0c0ffee65f0c0ffee65f0' },
      at: { $date: '2026-01-02T03:04:05.000Z' },
      n: { $numberLong: '9007199254740993' },
      d: { $numberDecimal: '1.10' },
      u: { $uuid: '0f8fad5b-d9cb-469f-a165-70867728950e' },
      when: { $date: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('turns a regex literal into Extended JSON', () => {
    expect(parseMongoValue('{ email: /@example\\.com$/i }')).toEqual({
      email: { $regularExpression: { pattern: '@example\\.com$', options: 'i' } },
    });
  });

  it('handles escapes and quotes inside strings', () => {
    expect(parseMongoValue('{ a: "say \\"hi\\"\\n", b: \'it\\\'s\' }')).toEqual({
      a: 'say "hi"\n',
      b: "it's",
    });
  });

  it('refuses functions, variables and anything that would need JavaScript to run', () => {
    expect(() => parseMongoValue('{ $where: function() { return true } }')).toThrow(
      /cannot be run/i,
    );
    expect(() => parseMongoValue('{ a: someVariable }')).toThrow(/cannot be run/i);
    expect(() => parseMongoValue('{ a: 1 + 2 }')).toThrow();
    expect(() => parseMongoValue('{ a: ObjectId("nothex") }')).toThrow(/ObjectId/);
    expect(() => parseMongoValue('{ a: ISODate("not a date") }')).toThrow(/date/i);
  });
});

describe('parseMongoShell', () => {
  it('reads a find with a chain', () => {
    expect(
      parseMongoShell(
        'db.orders.find({ total: { $gt: 10 } }, { _id: 0 }).sort({ total: -1 }).limit(5)',
      ),
    ).toEqual({
      kind: 'collection',
      database: null,
      collection: 'orders',
      calls: [
        { method: 'find', args: [{ total: { $gt: 10 } }, { _id: 0 }] },
        { method: 'sort', args: [{ total: -1 }] },
        { method: 'limit', args: [5] },
      ],
    });
  });

  it('reads getCollection, bracket names and getSiblingDB', () => {
    expect(parseMongoShell('db.getCollection("my.orders").countDocuments({})')).toMatchObject({
      collection: 'my.orders',
      calls: [{ method: 'countDocuments', args: [{}] }],
    });
    expect(parseMongoShell("db['odd-name'].findOne()")).toMatchObject({ collection: 'odd-name' });
    expect(parseMongoShell('db.getSiblingDB("admin").system.users.find()')).toMatchObject({
      database: 'admin',
      collection: 'system.users',
    });
  });

  it('reads database methods', () => {
    expect(parseMongoShell('db.getCollectionNames()')).toEqual({
      kind: 'database',
      database: null,
      calls: [{ method: 'getCollectionNames', args: [] }],
    });
    expect(parseMongoShell('db.getSiblingDB("admin").runCommand({ ping: 1 })')).toEqual({
      kind: 'database',
      database: 'admin',
      calls: [{ method: 'runCommand', args: [{ ping: 1 }] }],
    });
  });

  it('reads show and use', () => {
    expect(parseMongoShell('show dbs')).toEqual({ kind: 'show', what: 'databases' });
    expect(parseMongoShell('show collections;')).toEqual({ kind: 'show', what: 'collections' });
    expect(parseMongoShell('use shop')).toEqual({ kind: 'use', database: 'shop' });
  });

  it('allows a trailing semicolon and comments', () => {
    expect(parseMongoShell('// newest first\ndb.orders.find().sort({ _id: -1 }); ')).toMatchObject({
      collection: 'orders',
    });
  });

  it('refuses what it cannot read safely', () => {
    expect(() => parseMongoShell('db.orders.find(); db.orders.drop()')).toThrow(/one command/i);
    expect(() => parseMongoShell('const x = 1')).toThrow(/db\./);
    expect(() => parseMongoShell('db.orders')).toThrow(/method/i);
    expect(() => parseMongoShell('db.orders.find(')).toThrow();
    expect(() => parseMongoShell('show everything')).toThrow(/show/);
  });
});
