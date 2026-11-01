import { describe, expect, it } from 'vitest';
import {
  accessStatements,
  changePasswordStatement,
  createUserStatements,
  dropUserStatement,
  maskSecret,
  settingStatement,
} from './admin.js';

/**
 * Users and settings in plain terms (a user, a database, an access level) turned into each
 * engine's own statements. The password goes into the statement, so the preview masks it.
 */

describe('settingStatement', () => {
  it.each([
    [
      'postgres',
      'work_mem',
      '64MB',
      'ALTER SYSTEM SET "work_mem" = \'64MB\';\nSELECT pg_reload_conf();',
    ],
    ['mysql', 'max_connections', '300', 'SET PERSIST `max_connections` = 300;'],
    ['mysql', 'sql_mode', 'STRICT_TRANS_TABLES', "SET PERSIST `sql_mode` = 'STRICT_TRANS_TABLES';"],
    ['mariadb', 'max_connections', '300', 'SET GLOBAL `max_connections` = 300;'],
    ['redis', 'maxmemory', '1gb', 'CONFIG SET maxmemory "1gb"'],
    [
      'mssql',
      'max degree of parallelism',
      '4',
      "EXEC sp_configure N'max degree of parallelism', 4;\nRECONFIGURE;",
    ],
    ['mongodb', 'notablescan', 'true', 'db.adminCommand({"setParameter":1,"notablescan":true})'],
    ['mongodb', 'logLevel', '2', 'db.adminCommand({"setParameter":1,"logLevel":2})'],
  ] as const)('sets %s %s', (engine, name, value, expected) => {
    expect(settingStatement(engine, name, value)).toBe(expected);
  });

  it('turns down a setting name that could carry another statement', () => {
    expect(() => settingStatement('postgres', 'a; drop table x', '1')).toThrow(/setting/i);
    expect(() => settingStatement('redis', 'maxmemory', 'a"\nFLUSHALL')).toThrow(/value/i);
  });

  it('keeps a Mongo setting that is not a number or a flag as text', () => {
    expect(settingStatement('mongodb', 'redactClientLogData', 'false')).toBe(
      'db.adminCommand({"setParameter":1,"redactClientLogData":false})',
    );
    expect(settingStatement('mongodb', 'traceExceptions', 'all')).toBe(
      'db.adminCommand({"setParameter":1,"traceExceptions":"all"})',
    );
  });

  it('turns down a SQL Server setting that is not a number', () => {
    expect(() => settingStatement('mssql', 'max degree of parallelism', 'four')).toThrow(/number/i);
  });

  it('says where settings cannot be changed', () => {
    expect(() => settingStatement('cassandra', 'x', '1')).toThrow(/cassandra\.yaml/i);
    expect(() => settingStatement('sqlite', 'x', '1')).toThrow(/pragma/i);
  });
});

describe('createUserStatements', () => {
  it('makes a Postgres login role with read access to one database', () => {
    expect(
      createUserStatements('postgres', {
        user: 'reporter',
        password: "p'w",
        database: 'shop',
        level: 'read',
      }),
    ).toEqual([
      `CREATE ROLE "reporter" WITH LOGIN PASSWORD 'p''w';`,
      'GRANT CONNECT ON DATABASE "shop" TO "reporter";',
      'GRANT USAGE ON SCHEMA public TO "reporter";',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "reporter";',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "reporter";',
    ]);
  });

  it('makes a MySQL user who can connect from anywhere unless a host is named', () => {
    expect(
      createUserStatements('mysql', {
        user: 'app',
        password: 'pw',
        database: 'shop',
        level: 'write',
      }),
    ).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED BY 'pw';",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.* TO 'app'@'%';",
    ]);
    expect(
      createUserStatements('mariadb', {
        user: 'app',
        password: 'pw',
        host: 'localhost',
        database: 'shop',
        level: 'admin',
      })[1],
    ).toBe("GRANT ALL PRIVILEGES ON `shop`.* TO 'app'@'localhost';");
  });

  it('makes users for SQL Server, Mongo, Cassandra and Redis', () => {
    expect(
      createUserStatements('mssql', {
        user: 'app',
        password: 'Pw1!',
        database: 'shop',
        level: 'write',
      }),
    ).toEqual([
      "CREATE LOGIN [app] WITH PASSWORD = N'Pw1!';",
      'USE [shop];',
      'CREATE USER [app] FOR LOGIN [app];',
      'ALTER ROLE [db_datareader] ADD MEMBER [app];',
      'ALTER ROLE [db_datawriter] ADD MEMBER [app];',
    ]);
    expect(
      createUserStatements('mongodb', {
        user: 'app',
        password: 'pw',
        database: 'shop',
        level: 'write',
      }),
    ).toEqual([
      'db.getSiblingDB("admin").createUser({"user":"app","pwd":"pw","roles":[{"role":"readWrite","db":"shop"}]})',
    ]);
    expect(
      createUserStatements('cassandra', {
        user: 'app',
        password: 'pw',
        database: 'ks',
        level: 'read',
      }),
    ).toEqual([
      `CREATE ROLE "app" WITH PASSWORD = 'pw' AND LOGIN = true;`,
      'GRANT SELECT ON KEYSPACE "ks" TO "app";',
    ]);
    expect(createUserStatements('redis', { user: 'app', password: 'pw', level: 'read' })).toEqual([
      'ACL SETUSER app on >pw ~* +@read',
    ]);
  });

  it('makes a user with no database access when none is given', () => {
    expect(createUserStatements('postgres', { user: 'u', password: 'pw' })).toEqual([
      `CREATE ROLE "u" WITH LOGIN PASSWORD 'pw';`,
    ]);
    expect(createUserStatements('mysql', { user: 'u', password: 'pw', level: 'read' })).toEqual([
      "CREATE USER 'u'@'%' IDENTIFIED BY 'pw';",
    ]);
    expect(createUserStatements('mssql', { user: 'u', password: 'pw', level: 'read' })).toEqual([
      "CREATE LOGIN [u] WITH PASSWORD = N'pw';",
    ]);
    expect(createUserStatements('cassandra', { user: 'u', password: 'pw', level: 'read' })).toEqual(
      [`CREATE ROLE "u" WITH PASSWORD = 'pw' AND LOGIN = true;`],
    );
    expect(
      createUserStatements('mongodb', { user: 'u', password: 'pw', database: 'shop' }),
    ).toEqual(['db.getSiblingDB("admin").createUser({"user":"u","pwd":"pw","roles":[]})']);
    expect(createUserStatements('redis', { user: 'u', password: 'pw' })).toEqual([
      'ACL SETUSER u on >pw ~* -@all',
    ]);
  });

  it('gives a Postgres user access to every table without naming a database', () => {
    expect(createUserStatements('postgres', { user: 'u', password: 'pw', level: 'admin' })).toEqual(
      [
        `CREATE ROLE "u" WITH LOGIN PASSWORD 'pw';`,
        'GRANT USAGE ON SCHEMA public TO "u";',
        'GRANT ALL ON ALL TABLES IN SCHEMA public TO "u";',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "u";',
      ],
    );
  });

  it('turns down a name or password it cannot write safely', () => {
    expect(() => createUserStatements('postgres', { user: '', password: 'pw' })).toThrow(/name/i);
    expect(() => createUserStatements('redis', { user: 'a b', password: 'pw' })).toThrow(/name/i);
    expect(() => createUserStatements('redis', { user: 'a', password: 'p w' })).toThrow(
      /password/i,
    );
    expect(() => createUserStatements('postgres', { user: 'u', password: '' })).toThrow(
      /password/i,
    );
    expect(() => createUserStatements('sqlite', { user: 'u', password: 'p' })).toThrow(/users/i);
  });
});

describe('accessStatements', () => {
  it('replaces what a user can do in a database with the level chosen', () => {
    expect(accessStatements('mysql', { user: 'app', database: 'shop', level: 'read' })).toEqual([
      "REVOKE ALL PRIVILEGES ON `shop`.* FROM 'app'@'%';",
      "GRANT SELECT ON `shop`.* TO 'app'@'%';",
    ]);
    expect(accessStatements('postgres', { user: 'app', database: 'shop', level: 'none' })).toEqual([
      'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "app";',
      'REVOKE ALL ON DATABASE "shop" FROM "app";',
    ]);
    expect(accessStatements('mongodb', { user: 'app', database: 'shop', level: 'admin' })).toEqual([
      'db.getSiblingDB("admin").revokeRolesFromUser("app", [{"role":"read","db":"shop"},{"role":"readWrite","db":"shop"},{"role":"dbOwner","db":"shop"}])',
      'db.getSiblingDB("admin").grantRolesToUser("app", [{"role":"dbOwner","db":"shop"}])',
    ]);
    expect(accessStatements('redis', { user: 'app', level: 'write' })).toEqual([
      'ACL SETUSER app resetkeys ~* -@all +@read +@write',
    ]);
  });

  it('grants the chosen level after revoking in Postgres, MariaDB and Cassandra', () => {
    expect(accessStatements('postgres', { user: 'app', database: 'shop', level: 'write' })).toEqual(
      [
        'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "app";',
        'GRANT CONNECT ON DATABASE "shop" TO "app";',
        'GRANT USAGE ON SCHEMA public TO "app";',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "app";',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app";',
      ],
    );
    expect(
      accessStatements('mariadb', {
        user: 'app',
        host: 'localhost',
        database: 'shop',
        level: 'none',
      }),
    ).toEqual(["REVOKE ALL PRIVILEGES ON `shop`.* FROM 'app'@'localhost';"]);
    expect(accessStatements('cassandra', { user: 'app', database: 'ks', level: 'admin' })).toEqual([
      'REVOKE ALL PERMISSIONS ON KEYSPACE "ks" FROM "app";',
      'GRANT ALL PERMISSIONS ON KEYSPACE "ks" TO "app";',
    ]);
  });

  it('drops every SQL Server role before adding the ones for the level', () => {
    const drops = [
      'ALTER ROLE [db_datareader] DROP MEMBER [app];',
      'ALTER ROLE [db_datawriter] DROP MEMBER [app];',
      'ALTER ROLE [db_owner] DROP MEMBER [app];',
    ];
    const head = ['USE [shop];', "IF USER_ID(N'app') IS NULL CREATE USER [app] FOR LOGIN [app];"];
    expect(accessStatements('mssql', { user: 'app', database: 'shop', level: 'admin' })).toEqual([
      ...head,
      ...drops,
      'ALTER ROLE [db_owner] ADD MEMBER [app];',
    ]);
    expect(accessStatements('mssql', { user: 'app', database: 'shop', level: 'none' })).toEqual([
      ...head,
      ...drops,
    ]);
  });

  it('only revokes when the level is none', () => {
    expect(
      accessStatements('mongodb', { user: 'app', database: 'shop', level: 'none' }),
    ).toHaveLength(1);
    expect(accessStatements('redis', { user: 'app', level: 'none' })).toEqual([
      'ACL SETUSER app resetkeys ~* -@all',
    ]);
  });

  it.each(['mysql', 'mssql', 'cassandra', 'mongodb'] as const)(
    'asks which database to change in %s',
    (engine) => {
      expect(() => accessStatements(engine, { user: 'app', level: 'read' })).toThrow(/pick the/i);
    },
  );

  it('turns down an engine without users', () => {
    expect(() => accessStatements('sqlite', { user: 'app', level: 'read' })).toThrow(/no users/i);
  });
});

describe('dropUserStatement and changePasswordStatement', () => {
  it.each([
    ['postgres', 'DROP ROLE "app";', `ALTER ROLE "app" WITH PASSWORD 'new';`],
    ['mysql', "DROP USER 'app'@'%';", "ALTER USER 'app'@'%' IDENTIFIED BY 'new';"],
    ['mssql', 'DROP LOGIN [app];', "ALTER LOGIN [app] WITH PASSWORD = N'new';"],
    [
      'mongodb',
      'db.getSiblingDB("admin").dropUser("app")',
      'db.getSiblingDB("admin").changeUserPassword("app", "new")',
    ],
    ['cassandra', 'DROP ROLE "app";', `ALTER ROLE "app" WITH PASSWORD = 'new';`],
    ['redis', 'ACL DELUSER app', 'ACL SETUSER app resetpass >new'],
  ] as const)('drops and re-keys a %s user', (engine, drop, change) => {
    expect(dropUserStatement(engine, { user: 'app' })).toBe(drop);
    expect(changePasswordStatement(engine, { user: 'app' }, 'new')).toBe(change);
  });

  it('turns down a missing or unsafe new password and an engine without users', () => {
    expect(() => changePasswordStatement('postgres', { user: 'app' }, '')).toThrow(/password/i);
    expect(() => changePasswordStatement('redis', { user: 'app' }, 'p w')).toThrow(/spaces/i);
    expect(() => changePasswordStatement('sqlite', { user: 'app' }, 'new')).toThrow(/no users/i);
    expect(() => dropUserStatement('sqlite', { user: 'app' })).toThrow(/no users/i);
  });
});

describe('maskSecret', () => {
  it('hides every copy of the password in a preview', () => {
    expect(maskSecret("CREATE ROLE x PASSWORD 'hunter2'; -- hunter2", 'hunter2')).toBe(
      "CREATE ROLE x PASSWORD '********'; -- ********",
    );
    expect(maskSecret('x', '')).toBe('x');
  });
});
