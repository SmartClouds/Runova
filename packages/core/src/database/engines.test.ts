import { describe, expect, it } from 'vitest';
import { DB_ENGINES, engineInfo, isDbEngine } from './engines.js';

/** The UI reads this table to decide what to show for an engine, so it has to be complete. */

describe('DB_ENGINES', () => {
  it('lists every supported engine once', () => {
    expect(DB_ENGINES.map((info) => info.engine)).toEqual([
      'postgres',
      'mysql',
      'mariadb',
      'mongodb',
      'redis',
      'sqlite',
      'cassandra',
      'mssql',
    ]);
  });

  it('gives every networked engine a default port, and SQLite none', () => {
    for (const info of DB_ENGINES) {
      if (info.engine === 'sqlite') expect(info.defaultPort).toBeNull();
      else expect(info.defaultPort).toBeGreaterThan(0);
    }
    expect(engineInfo('postgres').defaultPort).toBe(5432);
    expect(engineInfo('mssql').defaultPort).toBe(1433);
    expect(engineInfo('cassandra').defaultPort).toBe(9042);
  });

  it('only offers a table designer where tables exist', () => {
    expect(engineInfo('redis').capabilities.createTable).toBe(false);
    expect(engineInfo('postgres').capabilities.createTable).toBe(true);
    expect(engineInfo('mongodb').capabilities.createTable).toBe(true);
  });

  it('does not offer user management where the engine has none', () => {
    expect(engineInfo('sqlite').capabilities.users).toBe(false);
    for (const engine of [
      'postgres',
      'mysql',
      'mariadb',
      'mongodb',
      'redis',
      'cassandra',
      'mssql',
    ] as const) {
      expect(engineInfo(engine).capabilities.users).toBe(true);
    }
  });

  it('names the query language and the editor mode', () => {
    expect(engineInfo('postgres')).toMatchObject({ queryLanguage: 'sql', editorLanguage: 'pgsql' });
    expect(engineInfo('mysql')).toMatchObject({ queryLanguage: 'sql', editorLanguage: 'mysql' });
    expect(engineInfo('cassandra').queryLanguage).toBe('cql');
    expect(engineInfo('mongodb')).toMatchObject({
      queryLanguage: 'mongo',
      editorLanguage: 'javascript',
    });
    expect(engineInfo('redis').queryLanguage).toBe('redis');
  });

  it('has a sample query for every engine to fill an empty editor', () => {
    for (const info of DB_ENGINES) expect(info.sampleQuery.length).toBeGreaterThan(0);
  });
});

describe('engineInfo', () => {
  it('throws for an engine it does not know', () => {
    expect(() => engineInfo('oracle' as never)).toThrow(/unknown database engine/i);
  });
});

describe('isDbEngine', () => {
  it('accepts the known engines only', () => {
    expect(isDbEngine('postgres')).toBe(true);
    expect(isDbEngine('oracle')).toBe(false);
    expect(isDbEngine(3)).toBe(false);
  });
});
