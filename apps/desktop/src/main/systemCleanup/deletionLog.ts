import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DeletionLogEntry } from './engine/cleaner';

/**
 * A plain record of what Disk Cleanup removed, one JSON object per line. Removal is permanent
 * (a cache is too large for the Recycle Bin to be of any use), so this is how the person, or a
 * bug report, can tell what went and when. It rolls over to a second file when it gets large, so
 * it never grows without bound.
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export interface DeletionLog {
  append(entry: DeletionLogEntry): Promise<void>;
}

export function createDeletionLog(file: string, options: { maxBytes?: number } = {}): DeletionLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return {
    async append(entry) {
      await mkdir(dirname(file), { recursive: true });
      try {
        if ((await stat(file)).size >= maxBytes) await rename(file, `${file}.1`);
      } catch {
        // No file yet, which is fine: appending makes it.
      }
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8');
    },
  };
}
