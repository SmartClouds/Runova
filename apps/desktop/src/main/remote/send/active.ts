/**
 * The few things the rest of main asks of file sends (E112) without loading Runova Anywhere: how
 * many are still going, for the quit question, and stopping them when Runova quits.
 */

let live: { count(): number; stopForQuit(): void } | null = null;

export function setActiveFileSends(next: { count(): number; stopForQuit(): void } | null): void {
  live = next;
}

/** Sends and receives still going. */
export function activeFileSends(): number {
  return live?.count() ?? 0;
}

/** Runova is quitting: every send stops, and the other side is told. */
export function stopFileSendsForQuit(): void {
  live?.stopForQuit();
}
