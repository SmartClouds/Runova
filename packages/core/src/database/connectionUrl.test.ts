import { describe, expect, it } from 'vitest';
import { formatConnectionUrl, parseConnectionUrl } from './connectionUrl.js';

/** Adding a database by hand is one pasted URL, so every common URL form has to read right. */

describe('parseConnectionUrl', () => {
  it('reads a Postgres URL with everything in it', () => {
    expect(
      parseConnectionUrl('postgres://app:s%40cret@db.example.com:6543/shop?sslmode=require'),
    ).toEqual({
      engine: 'postgres',
      host: 'db.example.com',
      port: 6543,
      user: 'app',
      password: 's@cret',
      database: 'shop',
      tls: true,
    });
  });

  it('accepts postgresql:// and fills in the default port', () => {
    expect(parseConnectionUrl('postgresql://u@localhost/db')).toEqual({
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'u',
      database: 'db',
      tls: false,
    });
  });

  it('reads MySQL and MariaDB URLs', () => {
    expect(parseConnectionUrl('mysql://root:pw@127.0.0.1/app')).toMatchObject({
      engine: 'mysql',
      port: 3306,
      database: 'app',
    });
    expect(parseConnectionUrl('mariadb://root@h:3307')).toMatchObject({
      engine: 'mariadb',
      port: 3307,
    });
  });

  it('reads a Mongo URL with an auth database', () => {
    expect(parseConnectionUrl('mongodb://admin:pw@h:27018/app?authSource=admin')).toEqual({
      engine: 'mongodb',
      host: 'h',
      port: 27018,
      user: 'admin',
      password: 'pw',
      database: 'app',
      authDatabase: 'admin',
      tls: false,
    });
  });

  it('keeps a mongodb+srv host whole, since the driver looks the hosts up itself', () => {
    expect(parseConnectionUrl('mongodb+srv://u:p@cluster0.ab.mongodb.net/app')).toEqual({
      engine: 'mongodb',
      host: 'cluster0.ab.mongodb.net',
      port: null,
      user: 'u',
      password: 'p',
      database: 'app',
      srv: true,
      tls: true,
    });
  });

  it('reads Redis URLs, with the database number and TLS', () => {
    expect(parseConnectionUrl('redis://:pw@cache:6380/2')).toEqual({
      engine: 'redis',
      host: 'cache',
      port: 6380,
      password: 'pw',
      database: '2',
      tls: false,
    });
    expect(parseConnectionUrl('rediss://default:pw@cache')).toMatchObject({
      tls: true,
      user: 'default',
      port: 6379,
    });
  });

  it('reads SQL Server and Cassandra URLs', () => {
    expect(parseConnectionUrl('sqlserver://sa:pw@sql:1433/master')).toMatchObject({
      engine: 'mssql',
      port: 1433,
      database: 'master',
    });
    expect(parseConnectionUrl('mssql://sa:pw@sql')).toMatchObject({ engine: 'mssql', port: 1433 });
    expect(parseConnectionUrl('cassandra://c:pw@node1:9043/ks')).toMatchObject({
      engine: 'cassandra',
      port: 9043,
      database: 'ks',
    });
  });

  it('reads a SQLite file path', () => {
    expect(parseConnectionUrl('sqlite:///home/me/app.db')).toEqual({
      engine: 'sqlite',
      file: '/home/me/app.db',
    });
    expect(parseConnectionUrl('sqlite://C:/data/app.sqlite')).toEqual({
      engine: 'sqlite',
      file: 'C:/data/app.sqlite',
    });
  });

  it('trims the whitespace a paste often brings along', () => {
    expect(parseConnectionUrl('  redis://h  \n')).toMatchObject({ engine: 'redis', host: 'h' });
  });

  it('turns down a URL it cannot read, saying why', () => {
    expect(() => parseConnectionUrl('ftp://h')).toThrow(/not a database URL/i);
    expect(() => parseConnectionUrl('not a url')).toThrow(/not a database URL/i);
    expect(() => parseConnectionUrl('postgres://')).toThrow(/host/i);
    expect(() => parseConnectionUrl('postgres://h:99999/db')).toThrow(/port/i);
    expect(() => parseConnectionUrl('sqlite://')).toThrow(/file/i);
  });
});

describe('formatConnectionUrl', () => {
  it('writes a URL back without the password', () => {
    expect(
      formatConnectionUrl({
        engine: 'postgres',
        host: 'h',
        port: 5432,
        user: 'app',
        password: 'secret',
        database: 'shop',
        tls: false,
      }),
    ).toBe('postgres://app@h:5432/shop');
  });

  it('writes a SQLite file and a Mongo SRV host', () => {
    expect(formatConnectionUrl({ engine: 'sqlite', file: '/a/b.db' })).toBe('sqlite:///a/b.db');
    expect(
      formatConnectionUrl({ engine: 'mongodb', host: 'c.net', port: null, srv: true, tls: true }),
    ).toBe('mongodb+srv://c.net');
  });

  it('quotes a user name that would break the URL', () => {
    expect(
      formatConnectionUrl({ engine: 'mysql', host: 'h', port: 3306, user: 'a@b', tls: false }),
    ).toBe('mysql://a%40b@h:3306');
  });
});
