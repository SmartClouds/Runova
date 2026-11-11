import { rename } from 'node:fs/promises';

/**
 * What Windows says when something else has the file or folder open for a moment: a virus scanner,
 * the search indexer, or another part of the app reading the file a rename is about to replace.
 */
const BUSY_CODES = new Set(['EPERM', 'EBUSY']);
const RENAME_RETRIES = 4;
const RENAME_RETRY_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Moves a file or folder, trying again a few times when it is busy. Node's `rm` has a retry option
 * for this and `rename` does not. On Windows a rename onto a file that any handle still has open
 * fails, so a save that replaces a file another reader holds would fail without this. The wait
 * grows with each try, like `rm`'s does, and anything but a busy error is thrown at once.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  {
    rename: move = rename,
    wait = sleep,
  }: { rename?: (from: string, to: string) => Promise<void>; wait?: typeof sleep } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt > RENAME_RETRIES || code === undefined || !BUSY_CODES.has(code)) throw error;
      await wait(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}
