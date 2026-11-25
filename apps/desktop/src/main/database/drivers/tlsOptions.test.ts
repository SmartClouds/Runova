import { describe, expect, it } from 'vitest';
import { cassandraSslOptions } from './cassandra';
import { mongoClientOptions, mongoUrl } from './mongodb';
import { mssqlConfig, mssqlTlsOptions } from './mssql';
import { mysqlSslOptions } from './mysql';
import { clientConfig } from './postgres';
import { redisOptions } from './redis';
import { nodeTlsOptions, withCertificateHint } from './shared';
import type { DriverConnectOptions } from './types';

/**
 * Every driver used to turn "TLS on" into "accept any certificate", so a network attacker could
 * stand in for the database. These pin what each driver is handed for each mode.
 */

const direct = (overrides: Partial<DriverConnectOptions> = {}): DriverConnectOptions => ({
  engine: 'postgres',
  host: 'db.example.com',
  port: 5432,
  tls: true,
  srv: false,
  ...overrides,
});

/** Through an SSH forward: the driver dials 127.0.0.1, the certificate names the real host. */
const forwarded = (overrides: Partial<DriverConnectOptions> = {}) =>
  direct({ host: '127.0.0.1', port: 50001, tlsServername: 'db.internal', ...overrides });

/** A certificate stub that names `host`, for Node's own name check. */
const certFor = (host: string) =>
  ({ subject: { CN: host }, subjectaltname: `DNS:${host}` }) as never;

describe('nodeTlsOptions (pg, ioredis, cassandra-driver)', () => {
  it('is left out when TLS is off', () => {
    expect(nodeTlsOptions(direct({ tls: false }))).toBeUndefined();
  });

  it('checks the chain and the host name by default', () => {
    const options = nodeTlsOptions(direct());
    expect(options).toMatchObject({ rejectUnauthorized: true, servername: 'db.example.com' });
    const check = options?.checkServerIdentity;
    expect(check?.('db.example.com', certFor('db.example.com'))).toBeUndefined();
    expect(check?.('db.example.com', certFor('impostor.invalid'))).toBeInstanceOf(Error);
  });

  it('checks a forwarded connection against the original host, not 127.0.0.1', () => {
    const options = nodeTlsOptions(forwarded());
    expect(options).toMatchObject({ rejectUnauthorized: true, servername: 'db.internal' });
    expect(options?.checkServerIdentity?.('127.0.0.1', certFor('db.internal'))).toBeUndefined();
    expect(options?.checkServerIdentity?.('127.0.0.1', certFor('other.host'))).toBeInstanceOf(
      Error,
    );
  });

  it('sends no SNI for an IP address, but still checks it', () => {
    const options = nodeTlsOptions(forwarded({ tlsServername: '10.0.0.5' }));
    expect(options).not.toHaveProperty('servername');
    expect(options?.checkServerIdentity?.('127.0.0.1', certFor('db.internal'))).toBeInstanceOf(
      Error,
    );
  });

  it('checks the chain only for verify-ca', () => {
    const options = nodeTlsOptions(direct({ tlsMode: 'verify-ca' }));
    expect(options?.rejectUnauthorized).toBe(true);
    expect(options?.checkServerIdentity?.('x', certFor('other.host'))).toBeUndefined();
  });

  it('accepts any certificate only for an explicit require', () => {
    expect(nodeTlsOptions(direct({ tlsMode: 'require' }))).toEqual({ rejectUnauthorized: false });
  });
});

describe('postgres', () => {
  it('hands pg the checked TLS options', () => {
    expect(clientConfig(direct(), 'shop').ssl).toMatchObject({ rejectUnauthorized: true });
    expect(clientConfig(direct({ tlsMode: 'require' }), 'shop').ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(clientConfig(direct({ tls: false }), 'shop').ssl).toBeUndefined();
  });
});

describe('redis', () => {
  it('hands ioredis the checked TLS options', () => {
    expect(redisOptions(direct({ engine: 'redis' })).tls).toMatchObject({
      rejectUnauthorized: true,
      servername: 'db.example.com',
    });
    expect(redisOptions(forwarded({ engine: 'redis' })).tls).toMatchObject({
      servername: 'db.internal',
    });
    expect(redisOptions(direct({ engine: 'redis', tls: false }))).not.toHaveProperty('tls');
  });
});

describe('cassandra', () => {
  it('spells out the check, since the driver defaults to none', () => {
    expect(cassandraSslOptions(direct({ engine: 'cassandra' }))).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(cassandraSslOptions(direct({ engine: 'cassandra', tlsMode: 'require' }))).toEqual({
      rejectUnauthorized: false,
    });
  });
});

describe('mysql', () => {
  it('checks the chain and the name for a direct connection', () => {
    expect(mysqlSslOptions(direct({ engine: 'mysql' }))).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: true,
    });
  });

  it('checks the chain only through a forward, where mysql2 can only check 127.0.0.1', () => {
    expect(mysqlSslOptions(forwarded({ engine: 'mysql' }))).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: false,
    });
  });

  it('follows verify-ca and require', () => {
    expect(mysqlSslOptions(direct({ engine: 'mysql', tlsMode: 'verify-ca' }))).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: false,
    });
    expect(mysqlSslOptions(direct({ engine: 'mysql', tlsMode: 'require' }))).toEqual({
      rejectUnauthorized: false,
    });
    expect(mysqlSslOptions(direct({ engine: 'mysql', tls: false }))).toBeUndefined();
  });
});

describe('mongodb', () => {
  it('keeps the driver default check for a direct or srv connection', () => {
    const options = mongoClientOptions(direct({ engine: 'mongodb', srv: true, port: null }));
    expect(options.tls).toBe(true);
    expect(options).not.toHaveProperty('tlsAllowInvalidCertificates');
    expect(options).not.toHaveProperty('tlsAllowInvalidHostnames');
  });

  it('checks a forwarded connection against the original host', () => {
    const options = mongoClientOptions(forwarded({ engine: 'mongodb' }));
    expect(options).toMatchObject({ tls: true, servername: 'db.internal' });
    expect(options.checkServerIdentity?.('127.0.0.1', certFor('db.internal'))).toBeUndefined();
  });

  it('follows verify-ca and require', () => {
    expect(mongoClientOptions(direct({ engine: 'mongodb', tlsMode: 'verify-ca' }))).toMatchObject({
      tls: true,
      tlsAllowInvalidHostnames: true,
    });
    expect(mongoClientOptions(direct({ engine: 'mongodb', tlsMode: 'require' }))).toMatchObject({
      tls: true,
      tlsAllowInvalidCertificates: true,
    });
    expect(mongoClientOptions(direct({ engine: 'mongodb', tls: false }))).not.toHaveProperty('tls');
  });

  it('dials a URL whose host cannot add options or another address', () => {
    expect(mongoUrl({ host: 'db.internal', port: 27017, srv: false })).toBe(
      'mongodb://db.internal:27017/',
    );
    expect(mongoUrl({ host: 'c.mongodb.net', port: null, srv: true })).toBe(
      'mongodb+srv://c.mongodb.net/',
    );
    expect(mongoUrl({ host: '::1', port: 27017, srv: false })).toBe('mongodb://[::1]:27017/');
    const url = mongoUrl({
      host: 'db.internal/?tlsInsecure=true&authSource=admin#',
      port: 27017,
      srv: false,
    });
    expect(url).toBe(
      'mongodb://db.internal%2F%3FtlsInsecure%3Dtrue%26authSource%3Dadmin%23:27017/',
    );
    expect(url).not.toContain('?');
  });
});

describe('mssql', () => {
  it('trusts the certificate only for require, or for the sign-in-only encryption with TLS off', () => {
    expect(mssqlTlsOptions(direct({ engine: 'mssql' }))).toEqual({
      encrypt: true,
      trustServerCertificate: false,
    });
    expect(mssqlTlsOptions(direct({ engine: 'mssql', tlsMode: 'require' }))).toEqual({
      encrypt: true,
      trustServerCertificate: true,
    });
    expect(mssqlTlsOptions(direct({ engine: 'mssql', tls: false }))).toEqual({
      encrypt: false,
      trustServerCertificate: true,
    });
  });

  it('checks a forwarded connection against the original host', () => {
    expect(mssqlConfig(forwarded({ engine: 'mssql' })).options).toMatchObject({
      encrypt: true,
      trustServerCertificate: false,
      serverName: 'db.internal',
    });
  });
});

describe('withCertificateHint', () => {
  it('says how to opt out when the certificate check failed', () => {
    expect(withCertificateHint('self-signed certificate')).toMatch(
      /^self-signed certificate\. The server's certificate could not be verified\..*sslmode=require/,
    );
    expect(withCertificateHint("Hostname/IP does not match certificate's altnames: x")).toMatch(
      /sslmode=require/,
    );
  });

  it('leaves other errors alone', () => {
    expect(withCertificateHint('password authentication failed')).toBe(
      'password authentication failed',
    );
  });
});
