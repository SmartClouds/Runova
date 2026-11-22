import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertPathWithinRoots } from '../pathGuard';

/**
 * Files the user dropped into the window from anywhere on disk. The editor may open these even
 * when they sit outside every project, the way VS Code opens any file dragged onto it. Only the
 * exact files are let through, never their folders or neighbors, and only for this run.
 *
 * Paths reach this from the preload, which reads them off real dropped `File` objects with
 * `webUtils.getPathForFile`. The renderer has no way to name a path of its own here.
 */
const dropped = new Set<string>();

/** Lets the editor at the regular files among `paths`, and returns those. */
export async function allowDroppedFiles(paths: string[]): Promise<string[]> {
  const allowed: string[] = [];
  for (const path of paths) {
    try {
      const resolved = resolve(path);
      if (!(await stat(resolved)).isFile()) continue;
      dropped.add(await realpath(resolved));
      allowed.push(path);
    } catch {
      // Gone already, or not readable: nothing to open.
    }
  }
  return allowed;
}

async function wasDropped(path: string): Promise<boolean> {
  if (dropped.size === 0) return false;
  try {
    return dropped.has(await realpath(resolve(path)));
  } catch {
    return false;
  }
}

/**
 * The resolved path when it is inside an allowed root or is a file the user dropped. Throws the
 * root guard's error otherwise.
 */
export async function assertFileAllowed(path: string, roots: string[]): Promise<string> {
  try {
    return await assertPathWithinRoots(path, roots);
  } catch (error) {
    if (await wasDropped(path)) return resolve(path);
    throw error;
  }
}
