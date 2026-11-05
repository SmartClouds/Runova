import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmod, lstat, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { TRASH_MARK } from '@runova/core';

/**
 * Removing one thing from a cache: a version folder, a downloaded file, a link.
 *
 * Three rules keep this from doing harm:
 *
 * 1. Every removal passes a guard, called with the real path (links followed in the parent, not in
 *    the item itself). There is no way to call this without one.
 * 2. A link is removed itself and never followed, whether it is the item or sits inside it.
 * 3. A folder is renamed to `<name>.runova-trash-<id>` before anything in it is deleted. Tools
 *    mark a finished install with a file inside the folder (Playwright's INSTALLATION_COMPLETE,
 *    Cargo's .cargo-ok), so half-deleting the folder under its own name would leave something that
 *    looks installed and is not. Under the set-aside name no tool recognises it. On Windows the
 *    rename also fails when a file inside is open, which is a clean "in use" answer before any
 *    file is touched.
 *
 * It can be cancelled between entries, so one very large folder does not hold Cancel up. If it is,
 * what is left stays under the set-aside name and is finished the next time (see `TRASH_MARK`).
 */

export interface RemoveFs {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<Pick<Dirent, 'name' | 'isDirectory'>[]>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

const nodeFs: RemoveFs = {
  lstat,
  realpath,
  rename,
  readdir: (path) => readdir(path, { withFileTypes: true }),
  unlink,
  rmdir,
  chmod,
};

export type RemoveOutcome =
  | { status: 'removed' }
  /** There was nothing there, which is what was wanted. */
  | { status: 'gone' }
  | { status: 'refused'; reason: string }
  | { status: 'in-use'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'cancelled' };

export interface RemoveOptions {
  /** Returns why this path must not be removed, or null to allow it. Required, never skipped. */
  guard: (realPath: string) => string | null;
  signal?: AbortSignal;
  fs?: RemoveFs;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

const IN_USE = 'It is in use by another program, so some of it could not be removed.';
const ATTEMPTS = 4;
const RETRY_DELAY_MS = 150;
/** Entries of one folder removed at the same time. */
const PARALLEL = 8;

/** Codes that mean something else has the file, and often only for a moment. */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const MISSING = new Set(['ENOENT', 'ENOTDIR']);

class Cancelled extends Error {}

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException | null)?.code ?? '';
}

function messageOf(error: unknown): string {
  const code = codeOf(error);
  if (BUSY.has(code)) return IN_USE;
  return error instanceof Error ? error.message : String(error);
}

export async function removeItem(path: string, options: RemoveOptions): Promise<RemoveOutcome> {
  const fs = options.fs ?? nodeFs;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newId = options.newId ?? (() => randomBytes(4).toString('hex'));
  const { signal } = options;

  const checkAborted = (): void => {
    if (signal?.aborted) throw new Cancelled();
  };

  /** Runs one removal step, retrying while something else briefly holds the file. */
  async function retrying(step: () => Promise<void>, target: string, itemRoot: string) {
    let widened = false;
    for (let attempt = 1; ; attempt += 1) {
      checkAborted();
      try {
        await step();
        return;
      } catch (error) {
        const code = codeOf(error);
        if (MISSING.has(code)) return;
        if ((code === 'EPERM' || code === 'EACCES') && !widened) {
          // A read-only file or folder (Go makes its module cache so): allow writing and go again.
          widened = true;
          await widen(target, itemRoot);
          continue;
        }
        if (BUSY.has(code) && attempt < ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
    }
  }

  async function widen(target: string, itemRoot: string): Promise<void> {
    await fs.chmod(target, 0o777).catch(() => undefined);
    const parent = dirname(target);
    // Only what is inside the item is ours to change. Never the cache folders around it.
    if (parent === itemRoot || parent.startsWith(itemRoot + sep)) {
      await fs.chmod(parent, 0o777).catch(() => undefined);
    }
  }

  async function removeFolder(folder: string, itemRoot: string): Promise<void> {
    checkAborted();
    let entries: Pick<Dirent, 'name' | 'isDirectory'>[];
    try {
      entries = await fs.readdir(folder);
    } catch (error) {
      const code = codeOf(error);
      if (MISSING.has(code)) return;
      if (code !== 'EACCES' && code !== 'EPERM') throw error;
      await fs.chmod(folder, 0o777).catch(() => undefined);
      entries = await fs.readdir(folder);
    }
    for (let start = 0; start < entries.length; start += PARALLEL) {
      checkAborted();
      await Promise.all(
        entries.slice(start, start + PARALLEL).map(async (entry) => {
          const child = join(folder, entry.name);
          if (entry.isDirectory()) await removeFolder(child, itemRoot);
          else await retrying(() => fs.unlink(child), child, itemRoot);
        }),
      );
    }
    await retrying(() => fs.rmdir(folder), folder, itemRoot);
  }

  async function removeLink(link: string): Promise<void> {
    try {
      await fs.unlink(link);
    } catch (error) {
      // A Windows junction, or a link to a folder, is taken away like a folder, and the folder it
      // points at stays.
      if (!['EPERM', 'EISDIR', 'ENOTDIR', 'EACCES'].includes(codeOf(error))) throw error;
      await fs.rmdir(link);
    }
  }

  if (signal?.aborted) return { status: 'cancelled' };

  let info: Awaited<ReturnType<RemoveFs['lstat']>>;
  let real: string;
  try {
    info = await fs.lstat(path);
    real = join(await fs.realpath(dirname(path)), basename(path));
  } catch (error) {
    if (MISSING.has(codeOf(error))) return { status: 'gone' };
    return { status: 'failed', reason: messageOf(error) };
  }

  const refusal = options.guard(real);
  if (refusal !== null) return { status: 'refused', reason: refusal };

  try {
    if (info.isSymbolicLink()) {
      await removeLink(path);
      return { status: 'removed' };
    }

    let target = path;
    if (!basename(path).includes(TRASH_MARK)) {
      target = join(dirname(path), `${basename(path)}${TRASH_MARK}${newId()}`);
      try {
        await fs.rename(path, target);
      } catch (error) {
        const code = codeOf(error);
        if (MISSING.has(code)) return { status: 'gone' };
        if (BUSY.has(code)) {
          return { status: 'in-use', reason: 'It is in use by another program.' };
        }
        return { status: 'failed', reason: messageOf(error) };
      }
    }

    if (info.isDirectory()) await removeFolder(target, target);
    else await retrying(() => fs.unlink(target), target, target);
    return { status: 'removed' };
  } catch (error) {
    if (error instanceof Cancelled) return { status: 'cancelled' };
    return { status: 'failed', reason: messageOf(error) };
  }
}
