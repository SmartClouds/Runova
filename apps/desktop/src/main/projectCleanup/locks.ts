import { resolve, sep } from 'node:path';

/**
 * Folders that a deploy keeps in step with a remote server. Deleting one locally would be read at
 * the next deploy as "delete it on the server too", so they are shown but never offered.
 */
export interface CleanupLock {
  path: string;
  reason: string;
  /** Folder names inside the lock that the deploy never ships, which stay free to delete. */
  exceptNames?: ReadonlySet<string>;
}

/** A path as it is compared: resolved, and without case where the filesystem has none. */
export function folded(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/** Whether `inner` is `outer` or sits below it. Both are already `folded`. */
export function isWithin(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * Why a folder is locked, or null when it is not. A folder is locked when it sits inside a locked
 * folder, unless the lock leaves that name out, and when it contains one, since deleting it would
 * take the locked folder with it.
 */
export function lockReasonFor(
  folder: string,
  name: string,
  locks: readonly CleanupLock[],
): string | null {
  const here = folded(folder);
  for (const lock of locks) {
    const there = folded(lock.path);
    if (isWithin(there, here)) return lock.reason;
    if (isWithin(here, there) && !lock.exceptNames?.has(name)) return lock.reason;
  }
  return null;
}
