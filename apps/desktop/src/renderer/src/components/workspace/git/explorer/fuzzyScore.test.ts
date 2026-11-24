import { describe, expect, it } from 'vitest';
import { align, isWordStart, wordStarts } from './fuzzyScore';

function startsIn(text: string): string {
  return [...text].filter((_, at) => isWordStart(text, at)).join('');
}

function marked(text: string, query: string, words: boolean): string[] | null {
  const found = align(text.toLowerCase(), wordStarts(text), query, 0, text.length, words);
  return found ? found.ranges.map(([from, to]) => text.slice(from, to)) : null;
}

describe('isWordStart', () => {
  it('finds humps, separators and digits', () => {
    expect(startsIn('workspaceSearchStore')).toBe('wSS');
    expect(startsIn('git-panel_view.tsx')).toBe('gpvt');
    expect(startsIn('handler12Event')).toBe('h1E');
  });

  it('starts a word at the last capital of a run that a word follows', () => {
    expect(startsIn('HTTPServer')).toBe('HS');
    expect(startsIn('parseURL')).toBe('pU');
  });

  it('reads letters outside ASCII by their case', () => {
    expect(startsIn('übersichtÄnderung')).toBe('üÄ');
  });
});

describe('align', () => {
  it('starts every piece on a word when asked to', () => {
    expect(marked('PreRenameSecrets', 'prs', true)).toEqual(['P', 'R', 'S']);
    expect(marked('PreRenameSecrets', 'ens', true)).toBeNull();
  });

  it('lets later letters sit anywhere otherwise, but not the first', () => {
    expect(marked('GitPanel', 'gtpnl', false)).toEqual(['G', 'tP', 'n', 'l']);
    expect(marked('GitPanel', 'itpnl', false)).toBeNull();
  });

  it('picks the tightest lining-up, not the first one found', () => {
    expect(marked('store/restoreStore', 'store', true)).toEqual(['store']);
    expect(marked('sxxtore/Store', 'store', true)).toEqual(['Store']);
  });

  it('can be made to end past a point', () => {
    const text = 'ipc/explorer/ipc.ts';
    const found = align(text, wordStarts(text), 'ipc', 0, text.length, true, 13);
    expect(found?.first).toBe(13);
  });
});
