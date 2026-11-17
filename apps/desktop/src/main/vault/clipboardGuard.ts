import { createHash } from 'node:crypto';

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

const digest = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex');

/**
 * Copies a secret and clears it again later, but only if the clipboard still holds it. If the
 * user copied something else in the meantime, that stays put. Only a hash of the secret is
 * kept, so this object never holds the plaintext.
 *
 * The clipboard is asynchronous, so every write and every check-then-clear runs one after the
 * other. Otherwise a lock right after a copy could read the clipboard before the secret landed
 * on it, decide it isn't ours, and leave the secret there.
 */
export class ClipboardGuard {
  private pendingHash: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly onSettled: (result: { cleared: boolean }) => void,
  ) {}

  async copy(text: string, clearAfterMs: number | null): Promise<{ clearsAt: number | null }> {
    this.cancelTimer();
    const written = this.serial(() => this.clipboard.writeText(text));
    if (clearAfterMs === null) {
      this.pendingHash = null;
      await written;
      return { clearsAt: null };
    }
    this.pendingHash = digest(text);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.settle();
    }, clearAfterMs);
    const clearsAt = Date.now() + clearAfterMs;
    await written;
    return { clearsAt };
  }

  /** Clears now if the copied secret is still there. Resolves to whether it cleared. */
  async clearIfOurs(): Promise<boolean> {
    if (!this.pendingHash) return false;
    this.cancelTimer();
    return this.settle();
  }

  dispose(): void {
    this.cancelTimer();
    this.pendingHash = null;
  }

  private settle(): Promise<boolean> {
    const hash = this.pendingHash;
    this.pendingHash = null;
    return this.serial(async () => {
      const ours = hash !== null && digest(await this.clipboard.readText()) === hash;
      if (ours) await this.clipboard.writeText('');
      this.onSettled({ cleared: ours });
      return ours;
    });
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  toJSON(): Record<string, unknown> {
    return { pending: this.pendingHash !== null };
  }
}
