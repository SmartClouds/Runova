/**
 * Lets several readers share one reading. CPU use is worked out against the previous reading, so a
 * second reader polling on its own would shorten the window and make both sets of numbers jumpy.
 */
export function sharedSample<T>(
  read: () => Promise<T>,
  freshForMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let latest: { at: number; value: Promise<T> } | null = null;
  return () => {
    const time = now();
    if (latest && time - latest.at < freshForMs) return latest.value;
    const value = read();
    const current = { at: time, value };
    latest = current;
    value.catch(() => {
      if (latest === current) latest = null;
    });
    return value;
  };
}
