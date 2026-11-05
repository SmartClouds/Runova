import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The parts of a video's cache that can be thrown away: scene chunks (a render rebuilds them) and
 * media previews (proxies, posters, sprites and peaks, made again from the original). The other
 * folders in a video's cache hold voice recordings and narration and AI-generated media. Those can
 * cost the user time or money to make again, or cannot be made again at all, so nothing here
 * names them, and nothing here can reach them.
 */
export const CLEARABLE_CACHE = ['scenes', 'media'] as const;

/** How many bytes are in a folder. Links are not followed and a file that is gone counts for 0. */
async function folderBytes(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return 0;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return folderBytes(path);
      try {
        return (await lstat(path)).size;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** What clearing this video's cache would free. */
export async function videoCacheBytes(videoCacheDir: string): Promise<number> {
  const sizes = await Promise.all(
    CLEARABLE_CACHE.map(async (name) => {
      const path = join(videoCacheDir, name);
      return (await isLink(path)) ? 0 : folderBytes(path);
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** Deletes the clearable caches of one video and returns the bytes that freed. */
export async function clearVideoCache(videoCacheDir: string): Promise<number> {
  let freed = 0;
  for (const name of CLEARABLE_CACHE) {
    const path = join(videoCacheDir, name);
    // A link is removed as a link. Its target is not this video's cache to clear.
    if (!(await isLink(path))) freed += await folderBytes(path);
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  return freed;
}
