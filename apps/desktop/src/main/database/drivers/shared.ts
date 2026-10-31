/** Helpers every driver shares. */

/** Up to this many rows the grid shows an exact total; past it, the estimate is enough. */
export const EXACT_COUNT_LIMIT = 100_000;

/** Counting is cheap when the table is small, or its size is unknown and no filter makes it slow. */
export function countIsCheap(rowEstimate: number | null, filter: string | undefined): boolean {
  if (rowEstimate === null || rowEstimate < 0) return !filter?.trim();
  return rowEstimate <= EXACT_COUNT_LIMIT;
}

/** A driver's error as one readable sentence, without the stack. */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return describeError(error.errors[0]);
  }
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    const message = error.message || error.name;
    return typeof detail === 'string' && detail ? `${message} (${detail})` : message;
  }
  return String(error);
}
