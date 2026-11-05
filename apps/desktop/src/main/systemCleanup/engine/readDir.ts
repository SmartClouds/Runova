import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type DirReader, TRASH_MARK } from '@runova/core';

/**
 * Reads the folders of a cache for the rules in core, which see paths relative to the cache root
 * written with `/`. A folder that is not there lists as empty, and a folder this account may not
 * read lists as empty too (and is reported), so one locked folder does not stop the rest of a
 * cache from being listed.
 *
 * A link is never called a folder, so nothing is walked through one.
 */

export interface ReadFs {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Pick<Dirent, 'name' | 'isDirectory'>[]>;
}

const nodeFs: ReadFs = { readdir: (path, options) => readdir(path, options) };

const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const REFUSED = new Set(['EACCES', 'EPERM']);

export function createDirReader(
  root: string,
  fs: ReadFs = nodeFs,
  onUnreadable?: (relPath: string) => void,
  /** Called for each folder an earlier clean-up set aside to delete and did not finish. */
  onSetAside?: (relPath: string) => void,
): DirReader {
  return async (relPath) => {
    const folder = relPath === '' ? root : join(root, ...relPath.split('/'));
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.includes(TRASH_MARK)) {
          onSetAside?.(relPath === '' ? entry.name : `${relPath}/${entry.name}`);
        }
      }
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (MISSING.has(code)) return [];
      if (REFUSED.has(code)) {
        onUnreadable?.(relPath);
        return [];
      }
      throw error;
    }
  };
}
