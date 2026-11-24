import type { SymbolIndex } from '@shared/apiTypes';
import { SYMBOL_KINDS, type SymbolKind, symbolCategory } from '@shared/symbolKinds';
import {
  DEFAULT_SEARCH_LIMIT,
  type PreparedSearch,
  prepareSearch,
  searchFiles,
} from '@/components/workspace/git/explorer/fileSearch';

/**
 * One half of the symbol index (the types, or the members) laid out for ranking. The lowered
 * copies are made once per index, not once per keystroke.
 */
export interface SymbolView {
  /** Positions in the full index. */
  ids: Uint32Array;
  names: string[];
  prepared: PreparedSearch;
  /** `Container.name`, for a query that names the type too. */
  qualified: string[];
  qualifiedPrepared: PreparedSearch;
}

export interface SymbolHit {
  id: number;
  name: string;
  container: string;
  kind: SymbolKind;
  path: string;
  line: number;
  column: number;
  /** What the row shows: the name, or `Container.name` when the query had a dot. */
  label: string;
  /** [start, end) inside `label` that matched. */
  ranges: [number, number][];
}

export interface SymbolSearchResult {
  hits: SymbolHit[];
  total: number;
}

function view(index: SymbolIndex, ids: number[]): SymbolView {
  const names = ids.map((id) => index.names[id]);
  const qualified = ids.map((id) =>
    index.containers[id] ? `${index.containers[id]}.${index.names[id]}` : index.names[id],
  );
  return {
    ids: Uint32Array.from(ids),
    names,
    prepared: prepareSearch(names),
    qualified,
    qualifiedPrepared: prepareSearch(qualified),
  };
}

export function splitSymbolIndex(index: SymbolIndex): { types: SymbolView; members: SymbolView } {
  const types: number[] = [];
  const members: number[] = [];
  for (let id = 0; id < index.names.length; id += 1) {
    const kind = SYMBOL_KINDS[index.kinds[id]] ?? 'function';
    (symbolCategory(kind) === 'type' ? types : members).push(id);
  }
  return { types: view(index, types), members: view(index, members) };
}

/**
 * Ranks one half of the index with the same scoring the file search uses, so a name that
 * starts with the query beats one that only contains its letters.
 */
export function searchSymbols(
  index: SymbolIndex,
  symbols: SymbolView,
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): SymbolSearchResult {
  const byContainer = query.includes('.');
  const labels = byContainer ? symbols.qualified : symbols.names;
  const result = searchFiles(labels, query, {
    limit,
    prepared: byContainer ? symbols.qualifiedPrepared : symbols.prepared,
  });
  return {
    total: result.total,
    hits: result.hits.map((hit) => {
      const id = symbols.ids[hit.index];
      return {
        id,
        name: index.names[id],
        container: index.containers[id],
        kind: SYMBOL_KINDS[index.kinds[id]] ?? 'function',
        path: index.files[index.fileOf[id]],
        line: index.lines[id],
        column: index.columns[id],
        label: hit.path,
        ranges: hit.ranges,
      };
    }),
  };
}
