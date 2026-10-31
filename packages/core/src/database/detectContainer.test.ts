import { describe, expect, it } from 'vitest';
import { CATALOG_IMAGES } from '../deploy/catalog/images.js';
import { credentialsFromEnv, detectContainer, engineFromImage } from './detectContainer.js';

/**
 * One click on a container card has to be enough to connect, so the engine, the port and the
 * sign-in must all come from what Docker already knows about the container.
 */

describe('engineFromImage', () => {
  it.each([
    ['postgres', 'postgres'],
    ['postgres:16-alpine', 'postgres'],
    ['docker.io/library/postgres:18.6@sha256:abc', 'postgres'],
    ['bitnami/postgresql:16', 'postgres'],
    ['postgis/postgis:16-3.4', 'postgres'],
    ['timescale/timescaledb:latest-pg16', 'postgres'],
    ['supabase/postgres:15.1', 'postgres'],
    ['mysql:8.4', 'mysql'],
    ['bitnami/mysql', 'mysql'],
    ['percona/percona-server:8.0', 'mysql'],
    ['mariadb:11', 'mariadb'],
    ['bitnami/mariadb:11', 'mariadb'],
    ['mongo:7', 'mongodb'],
    ['bitnami/mongodb:7.0', 'mongodb'],
    ['mongodb/mongodb-community-server:7.0-ubi8', 'mongodb'],
    ['redis:7-alpine', 'redis'],
    ['bitnami/redis', 'redis'],
    ['redis/redis-stack-server', 'redis'],
    ['valkey/valkey:8', 'redis'],
    ['eqalpha/keydb', 'redis'],
    ['cassandra:5', 'cassandra'],
    ['bitnami/cassandra:4.1', 'cassandra'],
    ['scylladb/scylla:6.1', 'cassandra'],
    ['mcr.microsoft.com/mssql/server:2022-latest', 'mssql'],
    ['mcr.microsoft.com/azure-sql-edge', 'mssql'],
    ['localhost:5000/team/postgres:16', 'postgres'],
  ])('reads %s as %s', (image, engine) => {
    expect(engineFromImage(image)).toBe(engine);
  });

  it.each([
    'nginx:1.27',
    'adminer',
    'phpmyadmin/phpmyadmin',
    'dpage/pgadmin4',
    'mongo-express',
    'redis-commander',
    'redislabs/redisinsight',
    'node:20',
    '',
  ])('does not take %s for a database', (image) => {
    expect(engineFromImage(image)).toBeNull();
  });

  it('reads every database image the App Store installs', () => {
    expect(engineFromImage(`${CATALOG_IMAGES.postgres18.repository}:18`)).toBe('postgres');
    expect(engineFromImage(`${CATALOG_IMAGES.mysql84.repository}:8.4`)).toBe('mysql');
    expect(engineFromImage(`${CATALOG_IMAGES.mariadb114.repository}:11.4`)).toBe('mariadb');
  });
});

describe('credentialsFromEnv', () => {
  it('takes the Postgres superuser, falling back to the image defaults', () => {
    expect(credentialsFromEnv('postgres', { POSTGRES_PASSWORD: 'pw' })).toEqual({
      user: 'postgres',
      password: 'pw',
      database: 'postgres',
    });
    expect(
      credentialsFromEnv('postgres', {
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'pw',
        POSTGRES_DB: 'shop',
      }),
    ).toEqual({ user: 'app', password: 'pw', database: 'shop' });
  });

  it('uses the user name as the database when POSTGRES_DB is left out, as the image does', () => {
    expect(
      credentialsFromEnv('postgres', { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw' }),
    ).toEqual({ user: 'app', password: 'pw', database: 'app' });
  });

  it('reads the bitnami Postgres names too', () => {
    expect(
      credentialsFromEnv('postgres', {
        POSTGRESQL_USERNAME: 'bit',
        POSTGRESQL_PASSWORD: 'pw',
        POSTGRESQL_DATABASE: 'db',
      }),
    ).toEqual({ user: 'bit', password: 'pw', database: 'db' });
  });

  it('prefers root for MySQL so every database can be managed', () => {
    expect(
      credentialsFromEnv('mysql', {
        MYSQL_ROOT_PASSWORD: 'root',
        MYSQL_USER: 'app',
        MYSQL_PASSWORD: 'apppw',
        MYSQL_DATABASE: 'shop',
      }),
    ).toEqual({ user: 'root', password: 'root', database: 'shop' });
  });

  it('falls back to the app user when MySQL has no root password', () => {
    expect(credentialsFromEnv('mysql', { MYSQL_USER: 'app', MYSQL_PASSWORD: 'apppw' })).toEqual({
      user: 'app',
      password: 'apppw',
    });
  });

  it('signs in to MySQL as root with no password when the container allows it', () => {
    expect(credentialsFromEnv('mysql', { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' })).toEqual({
      user: 'root',
      password: '',
    });
  });

  it('still names root for a MySQL whose password is not in the env', () => {
    expect(credentialsFromEnv('mysql', { MYSQL_DATABASE: 'shop' })).toEqual({
      user: 'root',
      database: 'shop',
    });
  });

  it('reads MariaDB names, and the MySQL names MariaDB still accepts', () => {
    expect(credentialsFromEnv('mariadb', { MARIADB_ROOT_PASSWORD: 'r' })).toEqual({
      user: 'root',
      password: 'r',
    });
    expect(credentialsFromEnv('mariadb', { MYSQL_ROOT_PASSWORD: 'r2' })).toEqual({
      user: 'root',
      password: 'r2',
    });
  });

  it('reads the Mongo root user and signs in against admin', () => {
    expect(
      credentialsFromEnv('mongodb', {
        MONGO_INITDB_ROOT_USERNAME: 'admin',
        MONGO_INITDB_ROOT_PASSWORD: 'pw',
      }),
    ).toEqual({ user: 'admin', password: 'pw', authDatabase: 'admin' });
  });

  it('connects to a Mongo with no auth with no credentials at all', () => {
    expect(credentialsFromEnv('mongodb', {})).toEqual({});
  });

  it('reads the Redis password from either name', () => {
    expect(credentialsFromEnv('redis', { REDIS_PASSWORD: 'pw' })).toEqual({ password: 'pw' });
    expect(credentialsFromEnv('redis', { REDISCLI_AUTH: 'pw2' })).toEqual({ password: 'pw2' });
  });

  it('signs in to SQL Server as sa', () => {
    expect(credentialsFromEnv('mssql', { MSSQL_SA_PASSWORD: 'Str0ng!' })).toEqual({
      user: 'sa',
      password: 'Str0ng!',
      database: 'master',
    });
    expect(credentialsFromEnv('mssql', { SA_PASSWORD: 'Old!' })).toEqual({
      user: 'sa',
      password: 'Old!',
      database: 'master',
    });
  });

  it('uses the Cassandra defaults unless bitnami set a password', () => {
    expect(credentialsFromEnv('cassandra', {})).toEqual({});
    expect(
      credentialsFromEnv('cassandra', { CASSANDRA_USER: 'c', CASSANDRA_PASSWORD: 'pw' }),
    ).toEqual({ user: 'c', password: 'pw' });
  });

  it('has nothing to read for SQLite', () => {
    expect(credentialsFromEnv('sqlite', { ANYTHING: 'x' })).toEqual({});
  });
});

describe('detectContainer', () => {
  it('puts the engine, the internal port and the sign-in together', () => {
    expect(
      detectContainer({
        image: 'postgres:16',
        env: { POSTGRES_PASSWORD: 'pw' },
        ports: [{ containerPort: 5432, hostPort: 15432 }],
      }),
    ).toEqual({
      engine: 'postgres',
      containerPort: 5432,
      hostPort: 15432,
      credentials: { user: 'postgres', password: 'pw', database: 'postgres' },
      needsPassword: false,
    });
  });

  it('uses the default port when the container lists none', () => {
    expect(detectContainer({ image: 'redis' })).toMatchObject({
      engine: 'redis',
      containerPort: 6379,
      hostPort: null,
      needsPassword: false,
    });
  });

  it('picks the port the engine listens on out of several', () => {
    expect(
      detectContainer({
        image: 'mysql',
        env: { MYSQL_ROOT_PASSWORD: 'r' },
        ports: [
          { containerPort: 33060, hostPort: 33060 },
          { containerPort: 3306, hostPort: 3307 },
        ],
      }),
    ).toMatchObject({ containerPort: 3306, hostPort: 3307 });
  });

  it('takes the only port a container exposes when it is not the default one', () => {
    expect(
      detectContainer({
        image: 'redis',
        ports: [{ containerPort: 6380, hostPort: null }],
      }),
    ).toMatchObject({ containerPort: 6380, hostPort: null });
  });

  it('honors a Postgres moved to another port by PGPORT', () => {
    expect(
      detectContainer({ image: 'postgres', env: { POSTGRES_PASSWORD: 'x', PGPORT: '6543' } }),
    ).toMatchObject({ containerPort: 6543 });
  });

  it('says a password is still needed when the engine needs one and none is in the env', () => {
    expect(detectContainer({ image: 'postgres:16', env: {} })).toMatchObject({
      needsPassword: true,
    });
    expect(detectContainer({ image: 'mcr.microsoft.com/mssql/server', env: {} })).toMatchObject({
      needsPassword: true,
    });
  });

  it('does not ask for a password Postgres was told not to want', () => {
    expect(
      detectContainer({ image: 'postgres', env: { POSTGRES_HOST_AUTH_METHOD: 'trust' } }),
    ).toMatchObject({ needsPassword: false });
  });

  it('answers null for a container that is not a database', () => {
    expect(detectContainer({ image: 'nginx', env: {} })).toBeNull();
  });
});
