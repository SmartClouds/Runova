import { packSymbolIndex, type SymbolEntry } from '@shared/symbolIndex';
import { describe, expect, it } from 'vitest';
import { searchSymbols, splitSymbolIndex } from './symbols';

function entry(partial: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'kind'>): SymbolEntry {
  return { container: '', path: 'src/a.ts', line: 1, column: 1, ...partial };
}

const INDEX = packSymbolIndex(
  [
    entry({ name: 'UserStore', kind: 'class', path: 'src/userStore.ts', line: 3, column: 14 }),
    entry({ name: 'load', kind: 'method', container: 'UserStore', path: 'src/userStore.ts' }),
    entry({ name: 'load', kind: 'function', path: 'src/io.ts', line: 9 }),
    entry({ name: 'User', kind: 'interface', path: 'src/types.ts' }),
    entry({ name: 'loadUsers', kind: 'function', path: 'src/api.ts' }),
  ],
  { version: 1, root: '/p', truncated: false, unavailable: false },
);

describe('splitSymbolIndex', () => {
  it('puts types and members in separate lists', () => {
    const { types, members } = splitSymbolIndex(INDEX);
    expect(types.names).toEqual(['UserStore', 'User']);
    expect(members.names).toEqual(['load', 'load', 'loadUsers']);
  });
});

describe('searchSymbols', () => {
  it('ranks types by name and says where each one is', () => {
    const { types } = splitSymbolIndex(INDEX);
    const [first, second] = searchSymbols(INDEX, types, 'user').hits;
    expect(first).toMatchObject({ name: 'User', kind: 'interface', path: 'src/types.ts' });
    expect(second).toMatchObject({
      name: 'UserStore',
      kind: 'class',
      path: 'src/userStore.ts',
      line: 3,
      column: 14,
    });
  });

  it('matches a member by its type when the query has a dot', () => {
    const { members } = splitSymbolIndex(INDEX);
    const result = searchSymbols(INDEX, members, 'userstore.lo');
    expect(result.hits.map((hit) => hit.label)).toEqual(['UserStore.load']);
    const [hit] = result.hits;
    expect(hit.ranges.map(([from, to]) => hit.label.slice(from, to)).join('')).toBe('UserStore.lo');
  });

  it('labels a member by its name alone otherwise', () => {
    const { members } = splitSymbolIndex(INDEX);
    const hits = searchSymbols(INDEX, members, 'load').hits;
    expect(hits.map((hit) => [hit.label, hit.container])).toEqual([
      ['load', 'UserStore'],
      ['load', ''],
      ['loadUsers', ''],
    ]);
  });

  it('finds a member by the first letters of its words, and not by letters spread out', () => {
    const index = packSymbolIndex(
      [
        entry({ name: 'PreRenameSecrets', kind: 'method', container: 'SecretsTests' }),
        entry({ name: 'ParseRequestHeaders', kind: 'method', container: 'Http' }),
        entry({ name: 'prepareRenderingContextForSecondaryScreens', kind: 'function' }),
      ],
      { version: 1, root: '/p', truncated: false, unavailable: false },
    );
    const { members } = splitSymbolIndex(index);
    const names = (query: string) => searchSymbols(index, members, query).hits.map((h) => h.name);
    expect(names('prs')[0]).toBe('PreRenameSecrets');
    expect(names('PreRenameSecrets')).toEqual(['PreRenameSecrets']);
    expect(names('secrets pre')).toEqual(['PreRenameSecrets']);
    expect(names('SecretsTests.prs')).toEqual(['PreRenameSecrets']);
  });

  it('finds nothing for an empty query', () => {
    const { members } = splitSymbolIndex(INDEX);
    expect(searchSymbols(INDEX, members, ' ')).toEqual({ hits: [], total: 0 });
  });

  it('keeps up with a big project', () => {
    const many = packSymbolIndex(
      Array.from({ length: 100_000 }, (_, at) =>
        entry({ name: `handler${at}Event`, kind: 'function', path: `src/f${at % 500}.ts` }),
      ),
      { version: 1, root: '/p', truncated: false, unavailable: false },
    );
    const { members } = splitSymbolIndex(many);
    const started = performance.now();
    const result = searchSymbols(many, members, 'hndlevt', 200);
    expect(result.hits).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
