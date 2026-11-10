import { once } from 'node:events';
import type { WriteStream } from 'node:fs';

/**
 * Closes a file stream that a download may never have used. createWriteStream opens its file a
 * moment later, so a download that fails first leaves that open still to come: removing the
 * partial file before the stream is closed races with it, and the file comes back, or the open
 * fails with nobody listening once its folder is gone.
 */
export async function closeFileStream(stream: WriteStream): Promise<void> {
  if (stream.closed) return;
  const closed = once(stream, 'close').catch(() => undefined);
  stream.destroy();
  await closed;
}
