import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConnection } from '../../shared/databaseTypes';
import { DatabaseBackups, localProcess } from './backup';
import { openDriver } from './drivers';
import {
  dockerAvailable,
  imageUsable,
  startDatabase,
  type TestDatabase,
  waitFor,
} from './drivers/testing/containers';
import type { DbDriver, DriverConnectOptions } from './drivers/types';

/**
 * A backup and restore round trip with the engines' own tools inside real containers: the
 * password reaches pg_dump and mariadb-dump only through their input, the table is dropped, and
 * the restore brings its rows back.
 */

const CASES: {
  label: string;
  image: string;
  port: number;
  env: Record<string, string>;
  engine: 'postgres' | 'mariadb';
  user: string;
  password: string;
}[] = [
  {
    label: 'PostgreSQL',
    image: 'postgres:17-alpine',
    port: 5432,
    env: { POSTGRES_PASSWORD: 'pg-secret', POSTGRES_DB: 'shop' },
    engine: 'postgres',
    user: 'postgres',
    password: 'pg-secret',
  },
  {
    label: 'MariaDB',
    image: 'mariadb:11',
    port: 3306,
    env: { MARIADB_ROOT_PASSWORD: 'maria-secret', MARIADB_DATABASE: 'shop' },
    engine: 'mariadb',
    user: 'root',
    password: 'maria-secret',
  },
];

const run = (driver: DbDriver, text: string) =>
  driver.query(text, { maxRows: 100, readOnly: false, signal: new AbortController().signal });

for (const engine of CASES) {
  describe.skipIf(!dockerAvailable() || !imageUsable(engine.image))(
    `${engine.label} backup`,
    () => {
      let db: TestDatabase;
      let driver: DbDriver;
      let options: DriverConnectOptions;

      beforeAll(async () => {
        db = startDatabase({ image: engine.image, port: engine.port, env: engine.env });
        options = {
          engine: engine.engine,
          host: db.host,
          port: db.port,
          user: engine.user,
          password: engine.password,
          database: 'shop',
          tls: false,
          srv: false,
        };
        driver = await waitFor(() => openDriver(options), 180_000);
        await run(driver, 'CREATE TABLE notes (id int PRIMARY KEY, body text)');
        await run(driver, "INSERT INTO notes VALUES (1, 'kept'), (2, 'also kept')");
      }, 240_000);

      afterAll(async () => {
        await driver?.close();
        db?.remove();
      });

      it('backs up, and restores what was dropped', async () => {
        const connection: DatabaseConnection = {
          id: 'c1',
          name: `${engine.label} test`,
          engine: engine.engine,
          target: {
            kind: 'localContainer',
            containerId: db.containerId,
            containerName: 'x',
            port: engine.port,
          },
          user: engine.user,
          database: 'shop',
          authDatabase: null,
          tls: false,
          srv: false,
          readOnly: false,
          hasPassword: true,
          locked: false,
          createdAt: 1,
          lastUsedAt: null,
        };
        const folder = mkdtempSync(join(tmpdir(), 'runova-backup-int-'));
        const backups = new DatabaseBackups({
          source: { connection: async () => connection, password: async () => engine.password },
          folder: () => folder,
          open: async (where, script) => {
            if (where.kind !== 'localContainer') throw new Error('local only');
            return localProcess(where.containerId, script);
          },
          progress: () => undefined,
        });

        const file = await backups.backup('c1');
        expect(file.size).toBeGreaterThan(100);
        expect((await backups.list('c1')).map((one) => one.name)).toEqual([file.name]);

        await run(driver, 'DROP TABLE notes');
        await backups.restore('c1', { name: file.name });
        // MariaDB's dump starts with USE, which moves this connection's session back to shop too.
        const rows = await run(
          driver,
          'SELECT body FROM shop.notes ORDER BY id'.replace(
            'shop.',
            engine.engine === 'postgres' ? '' : 'shop.',
          ),
        );
        expect(rows.error).toBeUndefined();
        expect(rows.results[0]?.rows).toEqual([['kept'], ['also kept']]);
      }, 120_000);

      // The official Postgres image trusts connections from inside its own container, so a wrong
      // password still works there; MariaDB checks it.
      it.skipIf(engine.engine === 'postgres')(
        'reports a wrong password from the tool itself',
        async () => {
          const folder = mkdtempSync(join(tmpdir(), 'runova-backup-int-'));
          const backups = new DatabaseBackups({
            source: {
              connection: async () => ({
                id: 'c1',
                name: 'x',
                engine: engine.engine,
                target: {
                  kind: 'localContainer',
                  containerId: db.containerId,
                  containerName: 'x',
                  port: engine.port,
                },
                user: engine.user,
                database: 'shop',
                authDatabase: null,
                tls: false,
                srv: false,
                readOnly: false,
                hasPassword: true,
                locked: false,
                createdAt: 1,
                lastUsedAt: null,
              }),
              password: async () => 'wrong',
            },
            folder: () => folder,
            open: async (where, script) =>
              localProcess((where as { containerId: string }).containerId, script),
            progress: () => undefined,
          });
          await expect(backups.backup('c1')).rejects.toThrow(/failed/i);
          expect(await backups.list('c1')).toEqual([]);
        },
        60_000,
      );
    },
  );
}
