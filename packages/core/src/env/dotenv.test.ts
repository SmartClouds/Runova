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

  it('treats a backslash at the end of a line as escaping only the newline', () => {
    // An escaped quote at the end of a line does not close the value.
    expect(parseDotenv('A="a\\"\nb"\nB=1')).toEqual([
      { key: 'A', value: 'a"\nb', line: 1 },
      { key: 'B', value: '1', line: 3 },
    ]);
    // A lone backslash at the end escapes the newline, so a quote opening the next line closes it.
    expect(parseDotenv('A="a\\\n"\nB=1')).toEqual([
      { key: 'A', value: 'a\\\n', line: 1 },
      { key: 'B', value: '1', line: 3 },
    ]);
    // Two backslashes are one escaped backslash, and the quote after them closes the value.
    expect(parseDotenv('A="a\\\\"\nB=1')[0]).toEqual({ key: 'A', value: 'a\\\\', line: 1 });
    // Single quotes have no escapes at all.
    expect(parseDotenv("A='a\\'\nB=1")[0]).toEqual({ key: 'A', value: 'a\\', line: 1 });
  });

  it('reads multi-line quoted values the same as scanning the joined text', () => {
    // The parser before it scanned each line once, kept here to check the two agree.
    function joinedScan(text: string): Array<[string, string, number]> {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const out: Array<[string, string, number]> = [];
      const close = (value: string, quote: string) => {
        for (let i = 0; i < value.length; i++) {
          if (value[i] === '\\' && quote === '"') {
            i++;
            continue;
          }
          if (value[i] === quote) return i;
        }
        return -1;
      };
      for (let index = 0; index < lines.length; index++) {
        const start = index + 1;
        let line = lines[index].trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice(7).trimStart();
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) continue;
        let rest = line.slice(eq + 1).trimStart();
        const quote = rest[0];
        if (quote === '"' || quote === "'" || quote === '`') {
          rest = rest.slice(1);
          let closing = close(rest, quote);
          while (closing < 0 && index + 1 < lines.length) {
            index++;
            rest += `\n${lines[index]}`;
            closing = close(rest, quote);
          }
          let value = closing < 0 ? rest : rest.slice(0, closing);
          if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
          out.push([key, value, start]);
          continue;
        }
        const comment = rest.search(/\s#/);
        out.push([key, (comment >= 0 ? rest.slice(0, comment) : rest).trim(), start]);
      }
      return out;
    }

    const pieces = ['A="', "B='", 'C=`', '"', "'", '`', '\\', 'x', ' ', '\n', '#', '=', 'n'];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 3000; round++) {
      let text = '';
      const length = 1 + (next() % 24);
      for (let i = 0; i < length; i++) text += pieces[next() % pieces.length];
      const got = parseDotenv(text).map((entry): [string, string, number] => [
        entry.key,
        entry.value,
        entry.line,
      ]);
      expect(got, JSON.stringify(text)).toEqual(joinedScan(text));
    }
  });

  it('parses a 1 MB multi-line quoted value quickly', () => {
    const closed = `A="${'x\n'.repeat(512 * 1024)}"\nB=1`;
    const unclosed = `A="${'\n'.repeat(1024 * 1024)}`;
    const started = performance.now();
    expect(countDotenvKeys(closed)).toBe(2);
    expect(parseDotenv(unclosed)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
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
