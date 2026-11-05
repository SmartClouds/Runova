import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { limiter } from '../util/limiter';

/**
 * How much disk a folder takes, found by walking it. Links are never followed (a project can carry
 * a junction to anywhere), a file that vanishes mid-walk is simply not counted, and a folder that
 * may not be read is skipped and counted in `unreadable`.
 *
 * The size is the size of the contents (`lstat().size`), not the blocks they occupy, so it is a
 * little under what Explorer or Finder show for folders of many small files.
 */

export interface TreeSize {
  bytes: number;
  files: number;
  /** Bytes in files that another name also points at. Deleting this folder does not free them. */
  sharedBytes: number;
  /** When anything under the folder last changed (ms since the epoch), 0 for an empty folder. */
  newestMs: number;
  /** Folders and files that could not be read. */
  unreadable: number;
}

type EntryKind = Pick<Dirent, 'name' | 'isDirectory' | 'isSymbolicLink'>;
type FileInfo = Pick<Stats, 'size' | 'nlink' | 'mtimeMs' | 'isDirectory' | 'isSymbolicLink'>;

/** The two filesystem calls the walk makes, so a test can make a file vanish or a folder refuse. */
export interface MeasureFs {
  readdir(path: string): Promise<EntryKind[]>;
  lstat(path: string): Promise<FileInfo>;
}

const realFs: MeasureFs = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  lstat: (path) => lstat(path),
};

export interface MeasureOptions {
  signal?: AbortSignal;
  fs?: MeasureFs;
  /** Most filesystem calls in flight at once. */
  concurrency?: number;
  /** Called with the number of files seen so far, every `progressEvery` files. */
  onFiles?: (files: number) => void;
  progressEvery?: number;
}

const DEFAULT_CONCURRENCY = 64;
const DEFAULT_PROGRESS_EVERY = 500;

function abortError(): Error {
  return new DOMException('The scan was cancelled.', 'AbortError');
}

/** The file is gone, or what was a folder is now a file. Either way there is nothing to count. */
function vanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export async function measureTree(path: string, options: MeasureOptions = {}): Promise<TreeSize> {
  const { signal, fs = realFs, onFiles } = options;
  const limit = limiter(options.concurrency ?? DEFAULT_CONCURRENCY);
  const progressEvery = options.progressEvery ?? DEFAULT_PROGRESS_EVERY;

  const total: TreeSize = { bytes: 0, files: 0, sharedBytes: 0, newestMs: 0, unreadable: 0 };
  let reported = 0;

  const checkAborted = (): void => {
    if (signal?.aborted) throw abortError();
  };

  const info = (target: string): Promise<FileInfo> =>
    limit(async () => {
      checkAborted();
      return fs.lstat(target);
    });
  const list = (target: string): Promise<EntryKind[]> =>
    limit(async () => {
      checkAborted();
      return fs.readdir(target);
    });

  function addFile(file: FileInfo): void {
    total.bytes += file.size;
    total.files += 1;
    if (file.nlink > 1) total.sharedBytes += file.size;
    if (file.mtimeMs > total.newestMs) total.newestMs = file.mtimeMs;
    if (onFiles && total.files - reported >= progressEvery) {
      reported = total.files;
      onFiles(total.files);
    }
  }

  /** Counts one problem, but lets a cancelled scan through as the cancellation it is. */
  function skip(error: unknown): void {
    checkAborted();
    if (!vanished(error)) total.unreadable += 1;
  }

  async function visitFolder(folder: string): Promise<void> {
    let entries: EntryKind[];
    try {
      entries = await list(folder);
    } catch (error) {
      skip(error);
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) return;
        const child = join(folder, entry.name);
        if (entry.isDirectory()) {
          await visitFolder(child);
          return;
        }
        try {
          addFile(await info(child));
        } catch (error) {
          skip(error);
        }
      }),
    );
  }

  checkAborted();
  let root: FileInfo;
  try {
    root = await info(path);
  } catch (error) {
    skip(error);
    return total;
  }
  if (root.isSymbolicLink()) return total;
  if (root.isDirectory()) await visitFolder(path);
  else addFile(root);
  return total;
}
