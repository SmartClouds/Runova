import { lstat, readdir } from 'node:fs/promises';
import { type MeasureFs, measureTree, type TreeSize } from '../../projectCleanup/sizeWalk';

/**
 * Measuring how much disk a cache or one of its folders takes. This is the project clean-up's
 * `measureTree` (it never follows a link, counts files with several names apart, survives a file
 * vanishing mid-walk, and can be cancelled), with a running total on top so the window can show
 * "12.4 GB so far" while a large cache is still being read.
 */

export interface Counters {
  bytes: number;
  files: number;
}

export function createCounters(): Counters {
  return { bytes: 0, files: 0 };
}

const nodeFs: MeasureFs = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  lstat: (path) => lstat(path),
};

/** Enough filesystem calls in flight to keep a disk busy without queueing the whole app behind them. */
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_PROGRESS_EVERY = 250;

export interface MeasurePathOptions {
  /** Totals shared by everything measured for one cache, so they add up across folders. */
  counters: Counters;
  signal?: AbortSignal;
  fs?: MeasureFs;
  concurrency?: number;
  progressEvery?: number;
  /** Called every `progressEvery` files with the running totals. */
  onTick?: (counters: Counters) => void;
}

export function measurePath(path: string, options: MeasurePathOptions): Promise<TreeSize> {
  const inner = options.fs ?? nodeFs;
  const { counters } = options;
  const counted: MeasureFs = {
    readdir: (target) => inner.readdir(target),
    lstat: async (target) => {
      const info = await inner.lstat(target);
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        counters.bytes += info.size;
        counters.files += 1;
      }
      return info;
    },
  };
  return measureTree(path, {
    signal: options.signal,
    fs: counted,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    progressEvery: options.progressEvery ?? DEFAULT_PROGRESS_EVERY,
    onFiles: () => options.onTick?.(counters),
  });
}
