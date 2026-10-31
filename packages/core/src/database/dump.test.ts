import { describe, expect, it } from 'vitest';
import { backupPlan, restorePlan, shQuote } from './dump.js';

/**
 * Backups run the engine's own tool inside the database's container. The password never goes on
 * a command line: the script reads it from the first line of its input, so only the tool's
 * environment ever holds it.
 */

const pg = {
  engine: 'postgres' as const,
  user: 'app',
  database: 'shop',
  host: '127.0.0.1',
  port: 5432,
};

describe('shQuote', () => {
  it('quotes for sh, including single quotes inside', () => {
    expect(shQuote('plain')).toBe("'plain'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(shQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
  });
});

describe('backupPlan', () => {
  it('dumps Postgres in the custom format, with the password read from stdin', () => {
    const plan = backupPlan(pg);
    expect(plan).toMatchObject({ extension: 'dump', passwordOnStdin: true, complete: true });
    expect(plan.script).toBe(
      "IFS= read -r RUNOVA_DB_PASSWORD; export PGPASSWORD=\"$RUNOVA_DB_PASSWORD\"; exec pg_dump --format=custom --no-owner --no-privileges -h '127.0.0.1' -p 5432 -U 'app' 'shop'",
    );
  });

  it('dumps MySQL and MariaDB with whichever dump tool the image has', () => {
    const plan = backupPlan({ ...pg, engine: 'mariadb', user: 'root', port: 3306 });
    expect(plan.extension).toBe('sql');
    expect(plan.script).toContain('export MYSQL_PWD="$RUNOVA_DB_PASSWORD"');
    expect(plan.script).toContain('$(command -v mariadb-dump || command -v mysqldump)');
    expect(plan.script).toContain(
      "--single-transaction --routines --triggers --events -h '127.0.0.1' -P 3306 -u 'root' --databases 'shop'",
    );
  });

  it('dumps every MySQL database when none is named', () => {
    expect(backupPlan({ ...pg, engine: 'mysql', database: undefined }).script).toContain(
      '--all-databases',
    );
  });

  it('dumps Mongo as a gzipped archive, signing in against the auth database', () => {
    const plan = backupPlan({
      engine: 'mongodb',
      user: 'admin',
      authDatabase: 'admin',
      host: '127.0.0.1',
      port: 27017,
    });
    expect(plan.extension).toBe('archive.gz');
    expect(plan.script).toBe(
      "IFS= read -r RUNOVA_DB_PASSWORD; exec mongodump --archive --gzip --host '127.0.0.1' --port 27017 --username 'admin' --authenticationDatabase 'admin' --password \"$RUNOVA_DB_PASSWORD\"",
    );
  });

  it('dumps Mongo without auth when it has no user', () => {
    const plan = backupPlan({
      engine: 'mongodb',
      database: 'shop',
      host: '127.0.0.1',
      port: 27017,
    });
    expect(plan.passwordOnStdin).toBe(false);
    expect(plan.script).toBe(
      "exec mongodump --archive --gzip --host '127.0.0.1' --port 27017 --db 'shop'",
    );
  });

  it('saves a Redis snapshot', () => {
    const plan = backupPlan({ engine: 'redis', host: '127.0.0.1', port: 6379 });
    expect(plan.extension).toBe('rdb');
    expect(plan.script).toBe(
      'IFS= read -r RUNOVA_DB_PASSWORD; export REDISCLI_AUTH="$RUNOVA_DB_PASSWORD"; exec redis-cli -h \'127.0.0.1\' -p 6379 --rdb - >/dev/stdout 2>/dev/null',
    );
  });

  it('backs SQL Server up to a temporary file and streams it out', () => {
    const plan = backupPlan({
      engine: 'mssql',
      user: 'sa',
      database: 'shop',
      host: '127.0.0.1',
      port: 1433,
    });
    expect(plan.extension).toBe('bak');
    expect(plan.script).toContain(
      `-Q 'BACKUP DATABASE [shop] TO DISK = N'\\''/tmp/runova-backup.bak'\\'' WITH INIT, COPY_ONLY'`,
    );
    expect(plan.script).toContain('>&2');
    expect(plan.script).toContain('cat /tmp/runova-backup.bak');
    expect(plan.script).not.toMatch(/-P '/);
  });

  it('saves only the schema of a Cassandra keyspace, and says so', () => {
    const plan = backupPlan({
      engine: 'cassandra',
      user: 'cassandra',
      database: 'ks',
      host: '127.0.0.1',
      port: 9042,
    });
    expect(plan).toMatchObject({ extension: 'cql', complete: false });
    expect(plan.script).toContain(`-e 'DESCRIBE KEYSPACE "ks"'`);
  });

  it('turns down what it cannot back up this way', () => {
    expect(() => backupPlan({ engine: 'sqlite' })).toThrow(/file/i);
    expect(() => backupPlan({ ...pg, engine: 'mssql', database: undefined })).toThrow(/database/i);
    expect(() => backupPlan({ ...pg, port: Number.NaN })).toThrow(/port/i);
  });
});

describe('restorePlan', () => {
  it('restores Postgres, replacing what is there', () => {
    expect(restorePlan(pg).script).toBe(
      "IFS= read -r RUNOVA_DB_PASSWORD; export PGPASSWORD=\"$RUNOVA_DB_PASSWORD\"; exec pg_restore --clean --if-exists --no-owner --no-privileges -h '127.0.0.1' -p 5432 -U 'app' -d 'shop'",
    );
  });

  it('restores MySQL, Mongo, SQL Server and Cassandra from stdin', () => {
    expect(restorePlan({ ...pg, engine: 'mysql', port: 3306 }).script).toContain(
      "exec $(command -v mariadb || command -v mysql) -h '127.0.0.1' -P 3306 -u 'app' 'shop'",
    );
    expect(restorePlan({ engine: 'mongodb', host: '127.0.0.1', port: 27017 }).script).toBe(
      "exec mongorestore --archive --gzip --drop --host '127.0.0.1' --port 27017",
    );
    const mssql = restorePlan({
      engine: 'mssql',
      user: 'sa',
      database: 'shop',
      host: '127.0.0.1',
      port: 1433,
    });
    expect(mssql.script).toContain('cat > /tmp/runova-restore.bak');
    expect(mssql.script).toContain(
      `-Q 'RESTORE DATABASE [shop] FROM DISK = N'\\''/tmp/runova-restore.bak'\\'' WITH REPLACE'`,
    );
    expect(restorePlan({ engine: 'cassandra', host: '127.0.0.1', port: 9042 }).script).toContain(
      '-f /dev/stdin',
    );
  });

  it('explains that Redis only loads a snapshot when it starts', () => {
    expect(() => restorePlan({ engine: 'redis', host: '127.0.0.1', port: 6379 })).toThrow(
      /restart/i,
    );
  });
});
