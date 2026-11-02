import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Runs `build` while holding `lock`, a folder only one process can create at a time. Workers run
 * side by side and often reach the same one-off build together (two specs starting at once), so
 * the second waits for the first and can then find the work already done.
 *
 * A worker killed mid-build leaves its lock behind, so a lock older than `staleMs` is taken over.
 */
export async function withBuildLock<T>(
  lock: string,
  staleMs: number,
  build: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - takenAt(lock) > staleMs) rmSync(lock, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await build();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** When the lock was taken, or now if it is already gone. */
function takenAt(lock: string): number {
  try {
    return statSync(lock).mtimeMs;
  } catch {
    return Date.now();
  }
}
