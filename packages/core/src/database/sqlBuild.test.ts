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
    expect(quoteLiteral('sqlite', 'a\\b')).toBe("'a\\b'");
  });

  it('writes PostgreSQL text with a backslash as E-string, safe with standard_conforming_strings off', () => {
    expect(quoteLiteral('postgres', 'a\\b')).toBe("E'a\\\\b'");
    // In a plain '...' string on such a server, \' escapes the quote and the rest would run.
    const hostile = "\\'; DROP TABLE users; --";
    expect(quoteLiteral('postgres', hostile)).toBe("E'\\\\''; DROP TABLE users; --'");
    expect(quoteLiteral('postgres', "it's")).toBe("'it''s'");
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

describe('buildReadRows with hostile input', () => {
  const ENGINES = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql'] as const;
  const page = { limit: 10, offset: 0 };

  it('keeps a table, schema and database name that tries to end the statement a name', () => {
    const name = 'x"; DROP TABLE y; --';
    expect(buildReadRows('postgres', { schema: 's"x', name }, page)).toBe(
      'SELECT * FROM "s""x"."x""; DROP TABLE y; --" LIMIT 10 OFFSET 0',
    );
    expect(buildReadRows('sqlite', { name }, page)).toBe(
      'SELECT * FROM "x""; DROP TABLE y; --" LIMIT 10 OFFSET 0',
    );
    expect(buildReadRows('mysql', { database: 'd`b', name: 'x`; DROP TABLE y; --' }, page)).toBe(
      'SELECT * FROM `d``b`.`x``; DROP TABLE y; --` LIMIT 10 OFFSET 0',
    );
    expect(
      buildReadRows(
        'mssql',
        { database: 'd]b', schema: 'dbo', name: 'x]; DROP TABLE y; --' },
        page,
      ),
    ).toBe(
      'SELECT * FROM [d]]b].[dbo].[x]]; DROP TABLE y; --] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY',
    );
  });

  it('keeps a dotted name one name instead of splitting it into schema and table', () => {
    expect(buildReadRows('postgres', { schema: 'public', name: 'a.b' }, page)).toBe(
      'SELECT * FROM "public"."a.b" LIMIT 10 OFFSET 0',
    );
  });

  it('quotes a sort column full of quote characters, and only ever sorts ASC or DESC', () => {
    const column = 'c"`]\'; DROP TABLE y; --';
    for (const engine of ENGINES) {
      const sql = buildReadRows(
        engine,
        { name: 't' },
        {
          ...page,
          orderBy: { column, direction: 'ASC; DROP TABLE y' as 'asc' },
        },
      );
      expect(sql).toContain(`ORDER BY ${quoteIdentifier(engine, column)} ASC`);
      expect(sql).not.toMatch(/ASC; DROP/);
    }
    const desc = buildReadRows(
      'postgres',
      { name: 't' },
      {
        ...page,
        orderBy: { column: 'id', direction: 'desc' },
      },
    );
    expect(desc).toContain('ORDER BY "id" DESC');
  });

  it('refuses to sort by a column the table does not have, when it knows the columns', () => {
    expect(() =>
      buildReadRows(
        'sqlite',
        { name: 't' },
        { ...page, orderBy: { column: 'id) DESC; DROP TABLE t; --', direction: 'asc' } },
        ['id', 'name'],
      ),
    ).toThrow(/no column/);
    expect(
      buildReadRows(
        'sqlite',
        { name: 't' },
        { ...page, orderBy: { column: 'name', direction: 'asc' } },
        ['id', 'name'],
      ),
    ).toBe('SELECT * FROM "t" ORDER BY "name" ASC LIMIT 10 OFFSET 0');
  });

  it('refuses a page size or offset that is not a whole number, whatever it holds', () => {
    for (const bad of ['10; DROP TABLE t', Number.POSITIVE_INFINITY, 1e20, -5, '10'] as unknown[]) {
      expect(() =>
        buildReadRows('postgres', { name: 't' }, { limit: bad as number, offset: 0 }),
      ).toThrow(/whole number/);
      expect(() =>
        buildReadRows('postgres', { name: 't' }, { limit: 10, offset: bad as number }),
      ).toThrow(/whole number/);
    }
  });

  it('refuses a filter that closes the WHERE bracket to add SQL of its own', () => {
    for (const engine of ENGINES) {
      for (const filter of [
        '1=1) UNION SELECT password FROM users --',
        '1=1) COMMIT DROP TABLE y SELECT * FROM t WHERE (1=1',
        '(1=1',
        ') OR (1=1',
      ]) {
        expect(() => buildReadRows(engine, { name: 't' }, { ...page, filter })).toThrow(
          /one condition/,
        );
      }
    }
  });

  it('refuses a filter that hides a second statement in a PostgreSQL E-string', () => {
    // A scanner that does not know E'...' sees one string here; the server ends it after \'
    // and runs the rest.
    const filter = "x = E'\\'' ) ; COMMIT; DROP TABLE y; SELECT ( '";
    expect(() => buildReadRows('postgres', { name: 't' }, { ...page, filter })).toThrow(
      /one condition/,
    );
  });

  it('refuses a filter whose plain string ends early on a server reading backslash escapes', () => {
    // With standard_conforming_strings on this is three short strings; with it off the first
    // string runs to the second quote and the semicolon after it ends the statement.
    const filter = "a = '\\' AND b = ';' AND c = '\\'";
    expect(() => buildReadRows('postgres', { name: 't' }, { ...page, filter })).toThrow(
      /one condition/,
    );
    expect(buildReadRows('sqlite', { name: 't' }, { ...page, filter })).toContain(
      `WHERE (${filter})`,
    );
  });

  it('allows brackets, quotes, % and _ that sit inside strings and names', () => {
    expect(
      buildReadRows(
        'postgres',
        { name: 't' },
        {
          ...page,
          filter: `"we(ird" = ')' AND name LIKE '100\\%' ESCAPE '\\' AND (a OR b)`,
        },
      ),
    ).toBe(
      `SELECT * FROM "t" WHERE ("we(ird" = ')' AND name LIKE '100\\%' ESCAPE '\\' AND (a OR b)) LIMIT 10 OFFSET 0`,
    );
    expect(buildReadRows('mssql', { name: 't' }, { ...page, filter: "[a)b] = N'('" })).toContain(
      "WHERE ([a)b] = N'(')",
    );
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
