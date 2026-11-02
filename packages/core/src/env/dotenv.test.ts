import { describe, expect, it } from 'vitest';
import {
  countDotenvKeys,
  diffDotenvKeys,
  guessEnvironmentKind,
  isEnvFileName,
  isEnvTemplateFileName,
  parseDotenv,
} from './dotenv.js';

describe('parseDotenv', () => {
  it('reads plain assignments, comments and export prefixes', () => {
    const text = [
      '# database',
      'DB_HOST=localhost',
      'export DB_PORT = 5432',
      '',
      'EMPTY=',
      'not a line',
      'URL=https://example.com/#anchor # trailing comment',
    ].join('\n');
    expect(parseDotenv(text)).toEqual([
      { key: 'DB_HOST', value: 'localhost', line: 2 },
      { key: 'DB_PORT', value: '5432', line: 3 },
      { key: 'EMPTY', value: '', line: 5 },
      { key: 'URL', value: 'https://example.com/#anchor', line: 7 },
    ]);
  });

  it('keeps quoted values whole, including # and =', () => {
    const entries = parseDotenv(`A="x # y = z"\nB='single'\nC=\`tick\``);
    expect(entries.map((e) => [e.key, e.value])).toEqual([
      ['A', 'x # y = z'],
      ['B', 'single'],
      ['C', 'tick'],
    ]);
  });

  it('expands \\n in double quotes only', () => {
    const entries = parseDotenv(`A="one\\ntwo"\nB='one\\ntwo'`);
    expect(entries[0].value).toBe('one\ntwo');
    expect(entries[1].value).toBe('one\\ntwo');
  });

  it('reads quoted values that span lines', () => {
    const text = 'KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1\r\n';
    const entries = parseDotenv(text);
    expect(entries).toEqual([
      { key: 'KEY', value: '-----BEGIN-----\nabc\n-----END-----', line: 1 },
      { key: 'NEXT', value: '1', line: 4 },
    ]);
  });

  it('counts a repeated key once', () => {
    expect(countDotenvKeys('A=1\nB=2\nA=3')).toBe(2);
  });
});

describe('env file names', () => {
  it('accepts the .env family and nothing with a path', () => {
    expect(isEnvFileName('.env')).toBe(true);
    expect(isEnvFileName('.env.production')).toBe(true);
    expect(isEnvFileName('.env.prod.local')).toBe(true);
    expect(isEnvFileName('env')).toBe(false);
    expect(isEnvFileName('.envrc')).toBe(false);
    expect(isEnvFileName('.env/../secret')).toBe(false);
    expect(isEnvFileName('..\\.env')).toBe(false);
    expect(isEnvFileName('.env.')).toBe(false);
  });

  it('spots templates', () => {
    expect(isEnvTemplateFileName('.env.example')).toBe(true);
    expect(isEnvTemplateFileName('.env.production')).toBe(false);
  });

  it('guesses the environment from the name', () => {
    expect(guessEnvironmentKind('.env')).toBe('development');
    expect(guessEnvironmentKind('.env.local')).toBe('development');
    expect(guessEnvironmentKind('.env.dev')).toBe('development');
    expect(guessEnvironmentKind('.env.production')).toBe('production');
    expect(guessEnvironmentKind('.env.prod.local')).toBe('production');
    expect(guessEnvironmentKind('.env.stage')).toBe('staging');
    expect(guessEnvironmentKind('.env.test')).toBe('test');
    expect(guessEnvironmentKind('.env.qa')).toBe('custom');
  });
});

describe('diffDotenvKeys', () => {
  it('names the keys added, removed and changed, in the order they appear', () => {
    const before = 'A=1\nB=2\nC=3\n';
    const after = 'C=3\nB=two\nD=4\nE=5\n';
    expect(diffDotenvKeys(before, after)).toEqual({
      added: ['D', 'E'],
      removed: ['A'],
      changed: ['B'],
    });
  });

  it('ignores comments, blank lines, quoting and export prefixes', () => {
    const before = '# old note\nA=1\nB="hello"\n';
    const after = 'export A=1\n\n# new note\nB=hello\n';
    expect(diffDotenvKeys(before, after)).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reads a key set twice the way dotenv does, the last value winning', () => {
    expect(diffDotenvKeys('A=1\nA=2\n', 'A=2\n')).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(diffDotenvKeys('A=1\n', 'A=1\nA=3\n').changed).toEqual(['A']);
  });

  it('handles empty files on either side', () => {
    expect(diffDotenvKeys('', 'A=1\n')).toEqual({ added: ['A'], removed: [], changed: [] });
    expect(diffDotenvKeys('A=1\n', '')).toEqual({ added: [], removed: ['A'], changed: [] });
    expect(diffDotenvKeys('', '')).toEqual({ added: [], removed: [], changed: [] });
  });
});
