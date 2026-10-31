import { quoteIdentifier } from './sqlBuild.js';
import type { DbEngine } from './types.js';

/**
 * Shell scripts for backing up and restoring with each engine's own tools, run inside the
 * database's container (or on the server, for a database installed there). A script that needs
 * the password reads it from the first line of its input into a variable, so the password is
 * never on a command line, where `ps` on the server would show it. A restore then reads the
 * backup from the rest of the input.
 */

export interface DumpOptions {
  engine: DbEngine;
  user?: string;
  database?: string;
  authDatabase?: string;
  /** Where the tool connects, seen from where it runs: 127.0.0.1 inside the container. */
  host?: string;
  port?: number;
}

export interface DumpPlan {
  script: string;
  /** The password goes in as the first line of input. */
  passwordOnStdin: boolean;
  /** The file extension for the backup, without the dot. */
  extension: string;
  /** False when the backup holds less than everything (Cassandra keeps only the schema). */
  complete: boolean;
}

const READ_PASSWORD = 'IFS= read -r RUNOVA_DB_PASSWORD;';
const PASSWORD = '"$RUNOVA_DB_PASSWORD"';

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function where(options: DumpOptions): { host: string; port: number } {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The backup needs the port the database listens on.');
  }
  return { host: shQuote(options.host ?? '127.0.0.1'), port };
}

function withPassword(
  variable: string | null,
  command: string,
  hasUser: boolean,
): DumpPlan['script'] {
  if (!hasUser || variable === null) return command;
  return `${READ_PASSWORD} export ${variable}=${PASSWORD}; ${command}`;
}

function needDatabase(options: DumpOptions): string {
  if (!options.database) throw new Error('Pick the database to back up or restore.');
  return options.database;
}

/** sqlcmd lives in different places in different SQL Server images. */
const SQLCMD =
  '"$(command -v sqlcmd || ls /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd 2>/dev/null | head -n 1)"';

function sqlcmd(options: DumpOptions, query: string): string {
  const { host, port } = where(options);
  // -C trusts the server's own certificate, which the tools18 client insists on otherwise.
  return `${SQLCMD} -C -b -S ${host},${port} -U ${shQuote(options.user ?? 'sa')} -P ${PASSWORD} -Q ${shQuote(query)}`;
}

function cqlsh(options: DumpOptions, rest: string): string {
  const { host, port } = where(options);
  const auth = options.user ? ` -u ${shQuote(options.user)} -p ${PASSWORD}` : '';
  return `exec cqlsh ${host} ${port}${auth} ${rest}`;
}

function mongoAuth(options: DumpOptions): string {
  if (!options.user) return '';
  return ` --username ${shQuote(options.user)} --authenticationDatabase ${shQuote(options.authDatabase ?? 'admin')} --password ${PASSWORD}`;
}

export function backupPlan(options: DumpOptions): DumpPlan {
  const hasUser = Boolean(options.user);
  switch (options.engine) {
    case 'postgres': {
      const { host, port } = where(options);
      const database = options.database ? ` ${shQuote(options.database)}` : '';
      return {
        script: withPassword(
          'PGPASSWORD',
          `exec pg_dump --format=custom --no-owner --no-privileges -h ${host} -p ${port} -U ${shQuote(options.user ?? 'postgres')}${database}`,
          true,
        ),
        passwordOnStdin: true,
        extension: 'dump',
        complete: true,
      };
    }
    case 'mysql':
    case 'mariadb': {
      const { host, port } = where(options);
      const which = options.database
        ? `--databases ${shQuote(options.database)}`
        : '--all-databases';
      return {
        script: withPassword(
          'MYSQL_PWD',
          `exec $(command -v mariadb-dump || command -v mysqldump) --single-transaction --routines --triggers --events -h ${host} -P ${port} -u ${shQuote(options.user ?? 'root')} ${which}`,
          true,
        ),
        passwordOnStdin: true,
        extension: 'sql',
        complete: true,
      };
    }
    case 'mongodb': {
      const { host, port } = where(options);
      const database = options.database ? ` --db ${shQuote(options.database)}` : '';
      const command = `exec mongodump --archive --gzip --host ${host} --port ${port}${database}${mongoAuth(options)}`;
      return {
        script: hasUser ? `${READ_PASSWORD} ${command}` : command,
        passwordOnStdin: hasUser,
        extension: 'archive.gz',
        complete: true,
      };
    }
    case 'redis': {
      const { host, port } = where(options);
      return {
        script: withPassword(
          'REDISCLI_AUTH',
          `exec redis-cli -h ${host} -p ${port} --rdb - >/dev/stdout 2>/dev/null`,
          true,
        ),
        passwordOnStdin: true,
        extension: 'rdb',
        complete: true,
      };
    }
    case 'mssql': {
      const database = quoteIdentifier('mssql', needDatabase(options));
      const file = '/tmp/runova-backup.bak';
      return {
        script: `${READ_PASSWORD} ${sqlcmd(options, `BACKUP DATABASE ${database} TO DISK = N'${file}' WITH INIT, COPY_ONLY`)} >&2 && cat ${file}; status=$?; rm -f ${file}; exit $status`,
        passwordOnStdin: true,
        extension: 'bak',
        complete: true,
      };
    }
    case 'cassandra': {
      const keyspace = needDatabase(options).replaceAll('"', '""');
      const command = cqlsh(options, `-e ${shQuote(`DESCRIBE KEYSPACE "${keyspace}"`)}`);
      return {
        script: hasUser ? `${READ_PASSWORD} ${command}` : command,
        passwordOnStdin: hasUser,
        extension: 'cql',
        complete: false,
      };
    }
    case 'sqlite':
      throw new Error('A SQLite database is a file; Runova copies the file itself.');
  }
}

export function restorePlan(options: DumpOptions): DumpPlan {
  const hasUser = Boolean(options.user);
  switch (options.engine) {
    case 'postgres': {
      const { host, port } = where(options);
      return {
        script: withPassword(
          'PGPASSWORD',
          `exec pg_restore --clean --if-exists --no-owner --no-privileges -h ${host} -p ${port} -U ${shQuote(options.user ?? 'postgres')} -d ${shQuote(needDatabase(options))}`,
          true,
        ),
        passwordOnStdin: true,
        extension: 'dump',
        complete: true,
      };
    }
    case 'mysql':
    case 'mariadb': {
      const { host, port } = where(options);
      const database = options.database ? ` ${shQuote(options.database)}` : '';
      return {
        script: withPassword(
          'MYSQL_PWD',
          `exec $(command -v mariadb || command -v mysql) -h ${host} -P ${port} -u ${shQuote(options.user ?? 'root')}${database}`,
          true,
        ),
        passwordOnStdin: true,
        extension: 'sql',
        complete: true,
      };
    }
    case 'mongodb': {
      const { host, port } = where(options);
      const command = `exec mongorestore --archive --gzip --drop --host ${host} --port ${port}${mongoAuth(options)}`;
      return {
        script: hasUser ? `${READ_PASSWORD} ${command}` : command,
        passwordOnStdin: hasUser,
        extension: 'archive.gz',
        complete: true,
      };
    }
    case 'mssql': {
      const database = quoteIdentifier('mssql', needDatabase(options));
      const file = '/tmp/runova-restore.bak';
      return {
        script: `${READ_PASSWORD} cat > ${file} && ${sqlcmd(options, `RESTORE DATABASE ${database} FROM DISK = N'${file}' WITH REPLACE`)} >&2; status=$?; rm -f ${file}; exit $status`,
        passwordOnStdin: true,
        extension: 'bak',
        complete: true,
      };
    }
    case 'cassandra': {
      const command = cqlsh(options, '-f /dev/stdin');
      return {
        script: hasUser ? `${READ_PASSWORD} ${command}` : command,
        passwordOnStdin: hasUser,
        extension: 'cql',
        complete: false,
      };
    }
    case 'redis':
      throw new Error(
        'Redis loads a snapshot only when it starts. Copy the file to its data folder as dump.rdb and restart the container.',
      );
    case 'sqlite':
      throw new Error('A SQLite database is a file; Runova copies the file itself.');
  }
}
