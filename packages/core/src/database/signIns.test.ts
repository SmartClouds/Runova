import { describe, expect, it } from 'vitest';
import { parseDotenv } from '../env/dotenv.js';
import { findSignIns } from './signIns.js';

/**
 * A compose project shaped like the ones Runova sees on servers: the Postgres container knows
 * its owner, the .env has the owner and app passwords, and the app containers are handed full
 * URLs built in the compose file.
 */

const postgres = {
  name: 'curalink-postgres',
  service: 'postgres',
  env: { POSTGRES_USER: 'curalink', POSTGRES_PASSWORD: 'ownerpw', POSTGRES_DB: 'curalink' },
  ports: [5432],
};

const api = {
  name: 'curalink-api',
  env: {
    DATABASE_URL: 'postgresql://curalink:ownerpw@postgres:5432/curalink?schema=public',
    DATABASE_URL_APP: 'postgresql://curalink_app:apppw@postgres:5432/curalink?schema=public',
    KEYCLOAK_DATABASE_URL: 'postgresql://keycloak:kcpw@postgres:5432/keycloak',
    REDIS_URL: 'redis://:redispw@redis:6379',
    OTHER_DB: 'postgresql://someone:pw@elsewhere.example.com:5432/x',
    NODE_ENV: 'production',
  },
};

describe('findSignIns', () => {
  it('finds the owner and every app sign-in, owner first, each once', () => {
    const found = findSignIns({ engine: 'postgres', database: postgres, siblings: [api] });
    expect(found.map((one) => [one.user, one.database, one.password, one.owner])).toEqual([
      ['curalink', 'curalink', 'ownerpw', true],
      ['curalink_app', 'curalink', 'apppw', false],
      ['keycloak', 'keycloak', 'kcpw', false],
    ]);
    expect(found[0]?.origin).toEqual({
      kind: 'container',
      where: 'curalink-postgres',
      key: 'POSTGRES_PASSWORD',
    });
    // DATABASE_URL is the owner again, so it is noted rather than listed twice.
    expect(found[0]?.alsoIn).toEqual([{ kind: 'app', where: 'curalink-api', key: 'DATABASE_URL' }]);
    expect(found[1]?.origin).toEqual({
      kind: 'app',
      where: 'curalink-api',
      key: 'DATABASE_URL_APP',
    });
  });

  it('matches the container name as a host too, and ignores other hosts and engines', () => {
    const found = findSignIns({
      engine: 'postgres',
      database: postgres,
      siblings: [
        {
          name: 'worker',
          env: {
            A: 'postgres://w:wpw@curalink-postgres/curalink',
            B: 'mysql://root:x@postgres:3306/db',
            C: 'postgres://x:y@db:5432/z',
          },
        },
      ],
    });
    expect(found.map((one) => one.user)).toEqual(['curalink', 'w']);
  });

  it('reads the .env: owner names and URLs, localhost ones only on a port the database has', () => {
    const entries = parseDotenv(
      [
        'POSTGRES_USER=curalink',
        'POSTGRES_PASSWORD=newerpw',
        'POSTGRES_DB=curalink',
        'APP_URL=postgres://report:rpw@localhost:5432/curalink',
        'WRONG_PORT=postgres://x:y@localhost:6543/curalink',
        'TEMPLATE=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/curalink',
      ].join('\n'),
    );
    const found = findSignIns({
      engine: 'postgres',
      database: postgres,
      envFile: { path: '/opt/curalink/.env', entries },
    });
    expect(found.map((one) => [one.user, one.password, one.origin.kind, one.origin.key])).toEqual([
      ['curalink', 'ownerpw', 'container', 'POSTGRES_PASSWORD'],
      ['curalink', 'newerpw', 'envFile', 'POSTGRES_PASSWORD'],
      ['report', 'rpw', 'envFile', 'APP_URL'],
    ]);
  });

  it('drops an owner with no password when the .env knows it', () => {
    const found = findSignIns({
      engine: 'postgres',
      database: {
        ...postgres,
        env: {
          POSTGRES_USER: 'curalink',
          POSTGRES_PASSWORD_FILE: '/run/secrets/pg',
          POSTGRES_DB: 'curalink',
        },
      },
      envFile: {
        path: '/opt/curalink/.env',
        entries: parseDotenv('POSTGRES_USER=curalink\nPOSTGRES_PASSWORD=pw\nPOSTGRES_DB=curalink'),
      },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ user: 'curalink', password: 'pw', owner: true });
    expect(found[0]?.origin.kind).toBe('envFile');
  });

  it('keeps an owner with no password when nothing else has one, so connect can ask', () => {
    const found = findSignIns({
      engine: 'postgres',
      database: { name: 'db', env: { POSTGRES_PASSWORD_FILE: '/run/secrets/pg' } },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ user: 'postgres', owner: true });
    expect(found[0]?.password).toBeUndefined();
  });

  it('reads a Redis password from an app URL', () => {
    const found = findSignIns({
      engine: 'redis',
      database: { name: 'curalink-redis', service: 'redis', env: {} },
      siblings: [api],
    });
    expect(found.map((one) => [one.user, one.password, one.owner])).toEqual([
      [null, 'redispw', false],
    ]);
  });

  it('takes a mysql URL for MariaDB', () => {
    const found = findSignIns({
      engine: 'mariadb',
      database: { name: 'shop-db', service: 'db', env: { MARIADB_ROOT_PASSWORD: 'root' } },
      siblings: [{ name: 'shop', env: { DATABASE_URL: 'mysql://shop:spw@db:3306/shop' } }],
    });
    expect(found.map((one) => one.user)).toEqual(['root', 'shop']);
  });

  it('gives each sign-in an id that is stable and carries no secret', () => {
    const first = findSignIns({ engine: 'postgres', database: postgres, siblings: [api] });
    const again = findSignIns({ engine: 'postgres', database: postgres, siblings: [api] });
    expect(first.map((one) => one.id)).toEqual(again.map((one) => one.id));
    expect(new Set(first.map((one) => one.id)).size).toBe(first.length);
    for (const one of first) {
      expect(one.id).toMatch(/^[a-z0-9]{14}$/);
      expect(one.id).not.toContain(one.password ?? '\u0000');
    }
  });
});
