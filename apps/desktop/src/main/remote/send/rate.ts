/** Samples closer than this say more about timer jitter than about the link. */
const MIN_SAMPLE_MS = 250;

/**
 * How fast a transfer moves, smoothed so the number on screen does not jump with every part:
 * each new reading pulls the rate halfway towards itself over `halfLifeMs`.
 */
export class RateMeter {
  private lastAt: number | null = null;
  private lastTotal = 0;
  private rate: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly halfLifeMs = 3_000,
  ) {}

  /** The bytes moved so far, in total. */
  update(total: number): void {
    const at = this.now();
    if (this.lastAt === null) {
      this.lastAt = at;
      this.lastTotal = total;
      return;
    }
    const elapsed = at - this.lastAt;
    if (elapsed < MIN_SAMPLE_MS) return;
    const reading = (Math.max(0, total - this.lastTotal) / elapsed) * 1000;
    const pull = 1 - 2 ** (-elapsed / this.halfLifeMs);
    this.rate = this.rate === null ? reading : this.rate + pull * (reading - this.rate);
    this.lastAt = at;
    this.lastTotal = total;
  }

  bytesPerSecond(): number | null {
    return this.rate === null ? null : Math.round(this.rate);
  }

  secondsLeft(remainingBytes: number): number | null {
    if (!this.rate) return null;
    return Math.round(remainingBytes / this.rate);
  }

  /** Forgets the past, for after a pause such as a reconnect. */
  reset(): void {
    this.lastAt = null;
    this.rate = null;
  }
}
