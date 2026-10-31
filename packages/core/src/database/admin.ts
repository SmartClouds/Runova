import { quoteIdentifier, quoteLiteral } from './sqlBuild.js';
import type { DbEngine } from './types.js';

/**
 * Settings and user access in plain terms, turned into each engine's statements. Access is a
 * level per database (none, read, write, admin), which is what people mean far more often than a
 * list of privileges.
 */

export type AccessLevel = 'none' | 'read' | 'write' | 'admin';

export interface UserRef {
  user: string;
  /** MySQL and MariaDB: where the user may connect from. "%" (anywhere) when left out. */
  host?: string;
}

export interface NewUser extends UserRef {
  password: string;
  database?: string;
  level?: AccessLevel;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

function checkName(name: string, pattern: RegExp, what: string): string {
  if (!pattern.test(name))
    throw new Error(`"${name}" is not a ${what} name Runova can write safely.`);
  return name;
}

const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const MSSQL_SETTING = /^[A-Za-z][A-Za-z0-9 _()-]{0,127}$/;

/** The statement that changes one server setting, kept across restarts where the engine can. */
export function settingStatement(engine: DbEngine, name: string, value: string): string {
  switch (engine) {
    case 'postgres':
      checkName(name, SETTING_NAME, 'setting');
      return `ALTER SYSTEM SET ${quoteIdentifier(engine, name)} = ${quoteLiteral(engine, value)};\nSELECT pg_reload_conf();`;
    case 'mysql':
    case 'mariadb': {
      checkName(name, SETTING_NAME, 'setting');
      const literal = NUMBER.test(value.trim()) ? value.trim() : quoteLiteral(engine, value);
      return `SET ${engine === 'mysql' ? 'PERSIST' : 'GLOBAL'} ${quoteIdentifier(engine, name)} = ${literal};`;
    }
    case 'redis':
      checkName(name, /^[a-z0-9-]{1,64}$/i, 'setting');
      if (/["\r\n\\]/.test(value))
        throw new Error('That value cannot be written as one Redis argument.');
      return `CONFIG SET ${name} "${value}"`;
    case 'mssql': {
      checkName(name, MSSQL_SETTING, 'setting');
      if (!NUMBER.test(value.trim())) throw new Error('SQL Server settings take a number.');
      return `EXEC sp_configure ${quoteLiteral(engine, name)}, ${value.trim()};\nRECONFIGURE;`;
    }
    case 'mongodb': {
      checkName(name, SETTING_NAME, 'setting');
      const text = value.trim();
      const parsed =
        text === 'true' ? true : text === 'false' ? false : NUMBER.test(text) ? Number(text) : text;
      return `db.adminCommand(${JSON.stringify({ setParameter: 1, [name]: parsed })})`;
    }
    case 'cassandra':
      throw new Error(
        'Cassandra reads its settings from cassandra.yaml when it starts, so they are shown here but not changed.',
      );
    case 'sqlite':
      throw new Error('SQLite has no server settings. Use a PRAGMA in a query instead.');
  }
}

const USER_NAME = /^[A-Za-z0-9_.@-]{1,63}$/;
const REDIS_SAFE = /^[^\s]+$/;

function host(ref: UserRef): string {
  return quoteLiteral('mysql', ref.host?.trim() || '%');
}

function mysqlUser(ref: UserRef): string {
  return `${quoteLiteral('mysql', ref.user)}@${host(ref)}`;
}

function checkUser(engine: DbEngine, ref: UserRef): void {
  checkName(ref.user, USER_NAME, 'user');
  if (engine === 'sqlite') throw new Error('SQLite has no users.');
}

const MYSQL_PRIVILEGES: Record<Exclude<AccessLevel, 'none'>, string> = {
  read: 'SELECT',
  write: 'SELECT, INSERT, UPDATE, DELETE',
  admin: 'ALL PRIVILEGES',
};
const PG_PRIVILEGES: Record<Exclude<AccessLevel, 'none'>, string> = {
  read: 'SELECT',
  write: 'SELECT, INSERT, UPDATE, DELETE',
  admin: 'ALL',
};
const MONGO_ROLES: Record<Exclude<AccessLevel, 'none'>, string> = {
  read: 'read',
  write: 'readWrite',
  admin: 'dbOwner',
};
const MSSQL_ROLES: Record<Exclude<AccessLevel, 'none'>, string[]> = {
  read: ['db_datareader'],
  write: ['db_datareader', 'db_datawriter'],
  admin: ['db_owner'],
};
const CASSANDRA_PERMISSIONS: Record<Exclude<AccessLevel, 'none'>, string[]> = {
  read: ['SELECT'],
  write: ['SELECT', 'MODIFY'],
  admin: ['ALL PERMISSIONS'],
};
const REDIS_CATEGORIES: Record<AccessLevel, string> = {
  none: '',
  read: '+@read',
  write: '+@read +@write',
  admin: '+@all',
};

/** The grants for one level, without revoking what was there. */
function grants(
  engine: DbEngine,
  ref: UserRef,
  database: string | undefined,
  level: AccessLevel,
): string[] {
  if (level === 'none') return [];
  const q = (name: string) => quoteIdentifier(engine, name);
  switch (engine) {
    case 'postgres': {
      const user = q(ref.user);
      return [
        ...(database ? [`GRANT CONNECT ON DATABASE ${q(database)} TO ${user};`] : []),
        `GRANT USAGE ON SCHEMA public TO ${user};`,
        `GRANT ${PG_PRIVILEGES[level]} ON ALL TABLES IN SCHEMA public TO ${user};`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${PG_PRIVILEGES[level]} ON TABLES TO ${user};`,
      ];
    }
    case 'mysql':
    case 'mariadb':
      if (!database) return [];
      return [`GRANT ${MYSQL_PRIVILEGES[level]} ON ${q(database)}.* TO ${mysqlUser(ref)};`];
    case 'mssql':
      if (!database) return [];
      return [
        `USE ${q(database)};`,
        `CREATE USER ${q(ref.user)} FOR LOGIN ${q(ref.user)};`,
        ...MSSQL_ROLES[level].map((role) => `ALTER ROLE ${q(role)} ADD MEMBER ${q(ref.user)};`),
      ];
    case 'cassandra':
      if (!database) return [];
      return CASSANDRA_PERMISSIONS[level].map(
        (permission) => `GRANT ${permission} ON KEYSPACE ${q(database)} TO ${q(ref.user)};`,
      );
    default:
      return [];
  }
}

export function createUserStatements(engine: DbEngine, input: NewUser): string[] {
  checkUser(engine, input);
  if (!input.password) throw new Error('Give the new user a password.');
  const level = input.level ?? 'none';
  const q = (name: string) => quoteIdentifier(engine, name);
  switch (engine) {
    case 'postgres':
      return [
        `CREATE ROLE ${q(input.user)} WITH LOGIN PASSWORD ${quoteLiteral(engine, input.password)};`,
        ...(input.database || level !== 'none' ? grants(engine, input, input.database, level) : []),
      ];
    case 'mysql':
    case 'mariadb':
      return [
        `CREATE USER ${mysqlUser(input)} IDENTIFIED BY ${quoteLiteral(engine, input.password)};`,
        ...grants(engine, input, input.database, level),
      ];
    case 'mssql':
      return [
        `CREATE LOGIN ${q(input.user)} WITH PASSWORD = ${quoteLiteral(engine, input.password)};`,
        ...grants(engine, input, input.database, level),
      ];
    case 'cassandra':
      return [
        `CREATE ROLE ${q(input.user)} WITH PASSWORD = ${quoteLiteral(engine, input.password)} AND LOGIN = true;`,
        ...grants(engine, input, input.database, level),
      ];
    case 'mongodb': {
      const roles =
        input.database && level !== 'none'
          ? [{ role: MONGO_ROLES[level], db: input.database }]
          : [];
      return [
        `db.getSiblingDB("admin").createUser(${JSON.stringify({ user: input.user, pwd: input.password, roles })})`,
      ];
    }
    case 'redis':
      if (!REDIS_SAFE.test(input.password))
        throw new Error('A Redis password cannot contain spaces.');
      return [
        `ACL SETUSER ${input.user} on >${input.password} ~* ${REDIS_CATEGORIES[level] || '-@all'}`,
      ];
    default:
      throw new Error(`${engine} has no users.`);
  }
}

/** Replaces what a user can do in one database with exactly the level chosen. */
export function accessStatements(
  engine: DbEngine,
  input: UserRef & { database?: string; level: AccessLevel },
): string[] {
  checkUser(engine, input);
  const q = (name: string) => quoteIdentifier(engine, name);
  const database = input.database;
  switch (engine) {
    case 'postgres':
      return [
        `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${q(input.user)};`,
        ...(input.level === 'none' && database
          ? [`REVOKE ALL ON DATABASE ${q(database)} FROM ${q(input.user)};`]
          : grants(engine, input, database, input.level)),
      ];
    case 'mysql':
    case 'mariadb':
      if (!database) throw new Error('Pick the database to change access to.');
      return [
        `REVOKE ALL PRIVILEGES ON ${q(database)}.* FROM ${mysqlUser(input)};`,
        ...grants(engine, input, database, input.level),
      ];
    case 'mssql': {
      if (!database) throw new Error('Pick the database to change access to.');
      const roles = ['db_datareader', 'db_datawriter', 'db_owner'];
      const wanted = input.level === 'none' ? [] : MSSQL_ROLES[input.level];
      return [
        `USE ${q(database)};`,
        `IF USER_ID(${quoteLiteral(engine, input.user)}) IS NULL CREATE USER ${q(input.user)} FOR LOGIN ${q(input.user)};`,
        ...roles.map((role) => `ALTER ROLE ${q(role)} DROP MEMBER ${q(input.user)};`),
        ...wanted.map((role) => `ALTER ROLE ${q(role)} ADD MEMBER ${q(input.user)};`),
      ];
    }
    case 'cassandra':
      if (!database) throw new Error('Pick the keyspace to change access to.');
      return [
        `REVOKE ALL PERMISSIONS ON KEYSPACE ${q(database)} FROM ${q(input.user)};`,
        ...grants(engine, input, database, input.level),
      ];
    case 'mongodb': {
      if (!database) throw new Error('Pick the database to change access to.');
      const all = Object.values(MONGO_ROLES).map((role) => ({ role, db: database }));
      const out = [
        `db.getSiblingDB("admin").revokeRolesFromUser(${JSON.stringify(input.user)}, ${JSON.stringify(all)})`,
      ];
      if (input.level !== 'none') {
        out.push(
          `db.getSiblingDB("admin").grantRolesToUser(${JSON.stringify(input.user)}, ${JSON.stringify([{ role: MONGO_ROLES[input.level], db: database }])})`,
        );
      }
      return out;
    }
    case 'redis':
      return [
        `ACL SETUSER ${input.user} resetkeys ~* -@all${input.level === 'none' ? '' : ` ${REDIS_CATEGORIES[input.level]}`}`,
      ];
    default:
      throw new Error(`${engine} has no users.`);
  }
}

export function dropUserStatement(engine: DbEngine, ref: UserRef): string {
  checkUser(engine, ref);
  const q = (name: string) => quoteIdentifier(engine, name);
  switch (engine) {
    case 'postgres':
    case 'cassandra':
      return `DROP ROLE ${q(ref.user)};`;
    case 'mysql':
    case 'mariadb':
      return `DROP USER ${mysqlUser(ref)};`;
    case 'mssql':
      return `DROP LOGIN ${q(ref.user)};`;
    case 'mongodb':
      return `db.getSiblingDB("admin").dropUser(${JSON.stringify(ref.user)})`;
    case 'redis':
      return `ACL DELUSER ${ref.user}`;
    default:
      throw new Error(`${engine} has no users.`);
  }
}

export function changePasswordStatement(engine: DbEngine, ref: UserRef, password: string): string {
  checkUser(engine, ref);
  if (!password) throw new Error('Type the new password.');
  const q = (name: string) => quoteIdentifier(engine, name);
  switch (engine) {
    case 'postgres':
      return `ALTER ROLE ${q(ref.user)} WITH PASSWORD ${quoteLiteral(engine, password)};`;
    case 'cassandra':
      return `ALTER ROLE ${q(ref.user)} WITH PASSWORD = ${quoteLiteral(engine, password)};`;
    case 'mysql':
    case 'mariadb':
      return `ALTER USER ${mysqlUser(ref)} IDENTIFIED BY ${quoteLiteral(engine, password)};`;
    case 'mssql':
      return `ALTER LOGIN ${q(ref.user)} WITH PASSWORD = ${quoteLiteral(engine, password)};`;
    case 'mongodb':
      return `db.getSiblingDB("admin").changeUserPassword(${JSON.stringify(ref.user)}, ${JSON.stringify(password)})`;
    case 'redis':
      if (!REDIS_SAFE.test(password)) throw new Error('A Redis password cannot contain spaces.');
      return `ACL SETUSER ${ref.user} resetpass >${password}`;
    default:
      throw new Error(`${engine} has no users.`);
  }
}

/** A statement with every copy of a secret (and its quoted form) replaced by stars, for a preview. */
export function maskSecret(text: string, secret: string): string {
  if (!secret) return text;
  const forms = [
    ...new Set([secret, secret.replaceAll("'", "''"), JSON.stringify(secret).slice(1, -1)]),
  ];
  let out = text;
  for (const form of forms.sort((a, b) => b.length - a.length))
    out = out.replaceAll(form, '********');
  return out;
}
