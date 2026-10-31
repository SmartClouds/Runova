import { describe, expect, it } from 'vitest';
import {
  buildReadRows,
  limitStatement,
  qualifiedName,
  quoteIdentifier,
  quoteLiteral,
} from './sqlBuild.js';

/**
 * The grid reads rows by building SQL from names the user picked in the tree, so every name has
 * to be quoted the way its engine wants, however odd it is.
 */

describe('quoteIdentifier', () => {
  it('uses double quotes for Postgres, SQLite and CQL, doubling any inside', () => {
    expect(quoteIdentifier('postgres', 'users')).toBe('"users"');
    expect(quoteIdentifier('postgres', 'we"ird')).toBe('"we""ird"');
    expect(quoteIdentifier('sqlite', 'a b')).toBe('"a b"');
    expect(quoteIdentifier('cassandra', 'Mixed')).toBe('"Mixed"');
  });

  it('uses backticks for MySQL and MariaDB', () => {
    expect(quoteIdentifier('mysql', 'or`der')).toBe('`or``der`');
    expect(quoteIdentifier('mariadb', 'x')).toBe('`x`');
  });

  it('uses brackets for SQL Server', () => {
    expect(quoteIdentifier('mssql', 'a]b')).toBe('[a]]b]');
  });
});

describe('quoteLiteral', () => {
  it('doubles single quotes', () => {
    expect(quoteLiteral('postgres', "it's")).toBe("'it''s'");
  });

  it('escapes backslashes for MySQL, which reads them inside strings', () => {
    expect(quoteLiteral('mysql', 'a\\b')).toBe("'a\\\\b'");
    expect(quoteLiteral('postgres', 'a\\b')).toBe("'a\\b'");
  });

  it('marks SQL Server strings as Unicode', () => {
    expect(quoteLiteral('mssql', 'é')).toBe("N'é'");
  });
});

describe('qualifiedName', () => {
  it('joins the parts the engine uses', () => {
    expect(qualifiedName('postgres', { schema: 'public', name: 't' })).toBe('"public"."t"');
    expect(qualifiedName('mysql', { database: 'shop', name: 't' })).toBe('`shop`.`t`');
    expect(qualifiedName('mssql', { database: 'db', schema: 'dbo', name: 't' })).toBe(
      '[db].[dbo].[t]',
    );
    expect(qualifiedName('cassandra', { database: 'ks', name: 't' })).toBe('"ks"."t"');
    expect(qualifiedName('sqlite', { name: 't' })).toBe('"t"');
  });

  it('leaves out the Postgres database, which is the connection itself', () => {
    expect(qualifiedName('postgres', { database: 'shop', schema: 's', name: 't' })).toBe('"s"."t"');
  });
});

describe('buildReadRows', () => {
  it('reads a page with LIMIT and OFFSET', () => {
    expect(
      buildReadRows('postgres', { schema: 'public', name: 'users' }, { limit: 100, offset: 200 }),
    ).toBe('SELECT * FROM "public"."users" LIMIT 100 OFFSET 200');
  });

  it('adds the filter and the sort', () => {
    expect(
      buildReadRows(
        'mysql',
        { database: 'shop', name: 'orders' },
        {
          limit: 50,
          offset: 0,
          filter: 'total > 10',
          orderBy: { column: 'created', direction: 'desc' },
        },
      ),
    ).toBe(
      'SELECT * FROM `shop`.`orders` WHERE (total > 10) ORDER BY `created` DESC LIMIT 50 OFFSET 0',
    );
  });

  it('uses OFFSET FETCH on SQL Server, which needs an ORDER BY for it', () => {
    expect(buildReadRows('mssql', { schema: 'dbo', name: 't' }, { limit: 10, offset: 20 })).toBe(
      'SELECT * FROM [dbo].[t] ORDER BY (SELECT NULL) OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY',
    );
    expect(
      buildReadRows(
        'mssql',
        { schema: 'dbo', name: 't' },
        {
          limit: 10,
          offset: 0,
          orderBy: { column: 'id', direction: 'asc' },
        },
      ),
    ).toBe('SELECT * FROM [dbo].[t] ORDER BY [id] ASC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY');
  });

  it('only limits on Cassandra, which has no OFFSET and sorts by its clustering key', () => {
    expect(
      buildReadRows(
        'cassandra',
        { database: 'ks', name: 't' },
        {
          limit: 100,
          offset: 0,
          filter: 'id = 3',
        },
      ),
    ).toBe('SELECT * FROM "ks"."t" WHERE id = 3 LIMIT 100 ALLOW FILTERING');
  });

  it('treats a blank filter as none', () => {
    expect(buildReadRows('sqlite', { name: 't' }, { limit: 5, offset: 0, filter: '   ' })).toBe(
      'SELECT * FROM "t" LIMIT 5 OFFSET 0',
    );
  });

  it('turns down a limit or offset that is not a small whole number', () => {
    expect(() => buildReadRows('sqlite', { name: 't' }, { limit: -1, offset: 0 })).toThrow();
    expect(() => buildReadRows('sqlite', { name: 't' }, { limit: 1.5, offset: 0 })).toThrow();
    expect(() =>
      buildReadRows('sqlite', { name: 't' }, { limit: 10, offset: Number.NaN }),
    ).toThrow();
    expect(() => buildReadRows('sqlite', { name: 't' }, { limit: 100_001, offset: 0 })).toThrow();
  });

  it('turns down a filter that would end the statement', () => {
    expect(() =>
      buildReadRows(
        'postgres',
        { name: 't' },
        { limit: 5, offset: 0, filter: '1=1; drop table t' },
      ),
    ).toThrow(/one condition/i);
  });

  it('allows a semicolon inside a quoted value in the filter', () => {
    expect(
      buildReadRows('postgres', { name: 't' }, { limit: 5, offset: 0, filter: "name = 'a;b'" }),
    ).toBe(`SELECT * FROM "t" WHERE (name = 'a;b') LIMIT 5 OFFSET 0`);
  });
});

describe('limitStatement', () => {
  it('wraps a plain SELECT so only the rows asked for come back', () => {
    expect(limitStatement('mysql', 'SELECT * FROM t', 1001)).toBe(
      'SELECT * FROM (SELECT * FROM t) AS runova_rows LIMIT 1001',
    );
    expect(limitStatement('postgres', 'with a as (select 1) select * from a;', 11)).toBe(
      'SELECT * FROM (with a as (select 1) select * from a) AS runova_rows LIMIT 11',
    );
  });

  it('leaves alone what cannot sit in a subquery', () => {
    expect(limitStatement('mysql', 'SHOW TABLES', 10)).toBeNull();
    expect(limitStatement('mysql', 'SELECT * FROM t LIMIT 5', 10)).toBeNull();
    expect(limitStatement('mysql', 'SELECT * FROM t FOR UPDATE', 10)).toBeNull();
    expect(limitStatement('mysql', 'SELECT 1 INTO @x', 10)).toBeNull();
    expect(limitStatement('mssql', 'SELECT * FROM t', 10)).toBeNull();
    expect(limitStatement('cassandra', 'SELECT * FROM t', 10)).toBeNull();
    expect(limitStatement('mysql', 'SELECT 1; SELECT 2', 10)).toBeNull();
  });
});
