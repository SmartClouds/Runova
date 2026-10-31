import { describe, expect, it } from 'vitest';
import { classifyStatement, splitStatements } from './classify.js';

/**
 * The classifier decides whether a query can run straight away (an AI answer, a read-only
 * connection) or needs the user to approve it first. A mistake toward "read" lets a write through
 * without asking, so anything it does not recognize counts as a write.
 */

describe('splitStatements', () => {
  it('splits on semicolons outside quotes, comments and dollar quotes', () => {
    expect(
      splitStatements(
        'postgres',
        `select 'a;b'; -- c;d
select "x;y" from t; /* e;f */ select $$g;h$$; select $tag$i;j$tag$`,
      ),
    ).toEqual([
      "select 'a;b'",
      `-- c;d
select "x;y" from t`,
      '/* e;f */ select $$g;h$$',
      'select $tag$i;j$tag$',
    ]);
  });

  it('handles escaped quotes and MySQL backticks', () => {
    expect(splitStatements('mysql', "select 'it''s; fine', `a;b` from t; select 1")).toEqual([
      "select 'it''s; fine', `a;b` from t",
      'select 1',
    ]);
    expect(splitStatements('mysql', "select 'a\\';b'; select 2")).toEqual([
      "select 'a\\';b'",
      'select 2',
    ]);
  });

  it('skips MySQL hash comments, closed or running to the end', () => {
    expect(splitStatements('mysql', 'select 1 # a;b\nfrom t; select 2 # end')).toEqual([
      'select 1 # a;b\nfrom t',
      'select 2 # end',
    ]);
  });

  it('splits SQL Server batches on GO lines', () => {
    expect(splitStatements('mssql', 'select 1\nGO\nselect 2\n  go  \nselect 3')).toEqual([
      'select 1',
      'select 2',
      'select 3',
    ]);
  });

  it('treats every line of Redis as its own command, and leaves Mongo whole', () => {
    expect(splitStatements('redis', 'GET a\n\n  SET b 1  \n# note\n')).toEqual([
      'GET a',
      'SET b 1',
    ]);
    expect(splitStatements('mongodb', 'db.users.find({a: ";"})')).toEqual([
      'db.users.find({a: ";"})',
    ]);
  });

  it('drops empty statements', () => {
    expect(splitStatements('postgres', ' ; ;select 1;;')).toEqual(['select 1']);
  });
});

describe('classifyStatement for SQL', () => {
  it.each([
    'SELECT * FROM users',
    '  select 1',
    '-- a note\nselect now()',
    '/* x */ SELECT 1',
    'WITH t AS (SELECT 1) SELECT * FROM t',
    'SHOW TABLES',
    'show max_connections',
    'EXPLAIN SELECT * FROM t',
    'DESCRIBE users',
    'DESC users',
    'VALUES (1), (2)',
    'TABLE users',
    'USE shop',
    "SELECT 'delete from x' AS s",
    'SELECT * FROM t WHERE "update" = 1',
  ])('reads %s as a read', (sql) => {
    expect(classifyStatement('postgres', sql)).toMatchObject({ kind: 'read', destructive: false });
  });

  it.each([
    ['INSERT INTO t VALUES (1)', false],
    ['UPDATE t SET a = 1 WHERE id = 2', false],
    ['UPDATE t SET a = 1', true],
    ['DELETE FROM t WHERE id = 1', false],
    ['delete from t', true],
    ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', false],
    ['REPLACE INTO t VALUES (1)', false],
    ['COPY t FROM STDIN', false],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', false],
    ['SELECT * INTO backup FROM t', false],
    ['SELECT * FROM t FOR UPDATE', false],
    ['EXPLAIN ANALYZE DELETE FROM t', true],
  ])('reads %s as a write (destructive: %s)', (sql, destructive) => {
    expect(classifyStatement('postgres', sql)).toEqual({ kind: 'write', destructive });
  });

  it.each([
    ['CREATE TABLE t (id int)', false],
    ['ALTER TABLE t ADD COLUMN a int', false],
    ['ALTER TABLE t DROP COLUMN a', true],
    ['DROP TABLE t', true],
    ['TRUNCATE t', true],
    ['RENAME TABLE a TO b', false],
    ['COMMENT ON TABLE t IS $$x$$', false],
    ['CREATE INDEX i ON t (a)', false],
  ])('reads %s as a schema change (destructive: %s)', (sql, destructive) => {
    expect(classifyStatement('postgres', sql)).toEqual({ kind: 'ddl', destructive });
  });

  it.each([
    'GRANT SELECT ON t TO bob',
    'REVOKE ALL ON t FROM bob',
    'CREATE USER bob',
    "CREATE ROLE bob LOGIN PASSWORD 'x'",
    'ALTER USER bob WITH PASSWORD $$x$$',
    'DROP USER bob',
    'ALTER SYSTEM SET work_mem = 1',
    'SET GLOBAL max_connections = 10',
    'VACUUM FULL t',
    'KILL 12',
    'SHUTDOWN',
    'SELECT pg_terminate_backend(123)',
    "SELECT set_config('a', 'b', false)",
    "select pg_read_file('/etc/passwd')",
    "SELECT nextval('s')",
    'BACKUP DATABASE x TO DISK = $$y$$',
    'EXEC sp_configure',
    'CALL do_stuff()',
    'DO $$ BEGIN END $$',
  ])('reads %s as an admin action', (sql) => {
    expect(classifyStatement('postgres', sql).kind).toBe('admin');
  });

  it('takes the most serious statement of several', () => {
    expect(classifyStatement('postgres', 'select 1; drop table t; select 2')).toEqual({
      kind: 'ddl',
      destructive: true,
    });
    expect(classifyStatement('postgres', 'select 1; insert into t values (1)').kind).toBe('write');
  });

  it('treats what it does not know, and an empty query, safely', () => {
    expect(classifyStatement('postgres', 'FROBNICATE t').kind).toBe('write');
    expect(classifyStatement('postgres', '')).toEqual({ kind: 'read', destructive: false });
    expect(classifyStatement('postgres', '-- only a note')).toEqual({
      kind: 'read',
      destructive: false,
    });
  });

  it('reads a SQLite pragma, and holds one that sets a value', () => {
    expect(classifyStatement('sqlite', 'PRAGMA table_info(users)').kind).toBe('read');
    expect(classifyStatement('sqlite', 'PRAGMA journal_mode = WAL').kind).toBe('admin');
  });

  it('reads a MySQL query with hash comments', () => {
    expect(classifyStatement('mysql', '# drop table t\nselect 1').kind).toBe('read');
  });

  it('leaves transaction control neutral', () => {
    expect(classifyStatement('postgres', 'BEGIN; SELECT 1; COMMIT').kind).toBe('read');
    expect(classifyStatement('mysql', 'START TRANSACTION; SELECT 1; ROLLBACK').kind).toBe('read');
  });

  it('reads SQL Server queries, including TOP and GO batches', () => {
    expect(classifyStatement('mssql', 'SELECT TOP 10 * FROM t\nGO').kind).toBe('read');
    expect(classifyStatement('mssql', 'select 1\ngo\ndelete from t').kind).toBe('write');
  });
});

describe('classifyStatement for CQL', () => {
  it.each([
    ['SELECT * FROM ks.t', 'read'],
    ['DESCRIBE KEYSPACES', 'read'],
    ['USE ks', 'read'],
    ['LIST ROLES', 'read'],
    ['INSERT INTO t (a) VALUES (1)', 'write'],
    ['BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH', 'write'],
    ['CREATE KEYSPACE k WITH replication = {}', 'ddl'],
    ['DROP KEYSPACE k', 'ddl'],
    ['CREATE ROLE r', 'admin'],
  ])('reads %s as %s', (cql, kind) => {
    expect(classifyStatement('cassandra', cql).kind).toBe(kind);
  });
});

describe('classifyStatement for Mongo', () => {
  it.each([
    ['db.users.find({ age: { $gt: 3 } })', 'read', false],
    ['db.users.find().sort({a: 1}).limit(5)', 'read', false],
    ['db.users.findOne()', 'read', false],
    ['db.users.aggregate([{ $match: {} }])', 'read', false],
    ['db.users.countDocuments({})', 'read', false],
    ['db.users.distinct("a")', 'read', false],
    ['db.users.getIndexes()', 'read', false],
    ['show collections', 'read', false],
    ['show dbs', 'read', false],
    ['db.getCollectionNames()', 'read', false],
    ['db.users.insertOne({a: 1})', 'write', false],
    ['db.users.updateMany({}, {$set: {a: 1}})', 'write', true],
    ['db.users.updateMany({a: 2}, {$set: {a: 1}})', 'write', false],
    ['db.users.deleteMany({})', 'write', true],
    ['db.users.deleteOne({ _id: 1 })', 'write', false],
    ['db.users.aggregate([{ $match: {} }, { $out: "copy" }])', 'write', false],
    ['db.users.aggregate([{ $merge: { into: "x" } }])', 'write', false],
    ['db.users.findOneAndUpdate({}, {$set: {}})', 'write', false],
    ['db.users.bulkWrite([])', 'write', false],
    ['db.users.createIndex({a: 1})', 'ddl', false],
    ['db.users.drop()', 'ddl', true],
    ['db.users.dropIndex("a_1")', 'ddl', true],
    ['db.createCollection("x")', 'ddl', false],
    ['db.dropDatabase()', 'ddl', true],
    ['db.createUser({user: "a", pwd: "b", roles: []})', 'admin', false],
    ['db.runCommand({ shutdown: 1 })', 'admin', false],
    ['db.adminCommand({ setParameter: 1 })', 'admin', false],
    ['db.users.frobnicate()', 'write', false],
    ['db.frobnicate()', 'write', false],
    ['use shop', 'read', false],
    ['print("hi")', 'write', false],
  ])('reads %s as %s (destructive: %s)', (query, kind, destructive) => {
    expect(classifyStatement('mongodb', query)).toEqual({ kind, destructive });
  });

  it('is not fooled by a write method named inside a string', () => {
    expect(classifyStatement('mongodb', 'db.users.find({ note: ".deleteMany(" })').kind).toBe(
      'read',
    );
  });

  it('reads through getSiblingDB to the call that matters', () => {
    expect(classifyStatement('mongodb', 'db.getSiblingDB("admin").dropUser("x")').kind).toBe(
      'admin',
    );
    expect(classifyStatement('mongodb', 'db.getSiblingDB("shop").dropDatabase()')).toEqual({
      kind: 'ddl',
      destructive: true,
    });
    expect(classifyStatement('mongodb', 'db.getSiblingDB("shop").orders.find({})').kind).toBe(
      'read',
    );
    expect(classifyStatement('mongodb', 'db.getMongo().getDBNames()').kind).toBe('write');
  });

  it('allows getCollection with an awkward name', () => {
    expect(classifyStatement('mongodb', 'db.getCollection("a.b").find({})').kind).toBe('read');
    expect(classifyStatement('mongodb', "db['a-b'].insertOne({})").kind).toBe('write');
  });
});

describe('classifyStatement for Redis', () => {
  it.each([
    ['GET a', 'read', false],
    ['hgetall user:1', 'read', false],
    ['SCAN 0 MATCH user:* COUNT 100', 'read', false],
    ['INFO memory', 'read', false],
    ['CONFIG GET maxmemory', 'read', false],
    ['TTL a', 'read', false],
    ['SET a 1', 'write', false],
    ['DEL a', 'write', true],
    ['UNLINK a b', 'write', true],
    ['EXPIRE a 10', 'write', false],
    ['HSET h f v', 'write', false],
    ['FLUSHDB', 'admin', true],
    ['FLUSHALL ASYNC', 'admin', true],
    ['CONFIG SET maxmemory 1gb', 'admin', false],
    ['ACL SETUSER bob on', 'admin', false],
    ['SHUTDOWN', 'admin', true],
    ['EVAL "return 1" 0', 'admin', false],
    ['MADEUP x', 'write', false],
  ])('reads %s as %s (destructive: %s)', (command, kind, destructive) => {
    expect(classifyStatement('redis', command)).toEqual({ kind, destructive });
  });

  it('takes the worst of several lines', () => {
    expect(classifyStatement('redis', 'GET a\nFLUSHALL')).toEqual({
      kind: 'admin',
      destructive: true,
    });
  });
});
