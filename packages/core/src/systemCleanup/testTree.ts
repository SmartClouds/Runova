import type { DirReader } from './types.js';

/**
 * A folder tree held in memory, for testing code that reads one through a `DirReader`. An object
 * is a folder, anything else (`null`, a string) is a file.
 */
export interface TreeSpec {
  [name: string]: TreeSpec | string | null;
}

export function memoryReader(tree: TreeSpec): DirReader & { reads: string[] } {
  const reads: string[] = [];
  const reader = async (relPath: string) => {
    reads.push(relPath);
    let node: TreeSpec | string | null = tree;
    for (const segment of relPath.split('/').filter(Boolean)) {
      node = node !== null && typeof node === 'object' ? (node[segment] ?? null) : null;
    }
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node)
      .map(([name, child]) => ({ name, isDirectory: child !== null && typeof child === 'object' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  return Object.assign(reader, { reads });
}
