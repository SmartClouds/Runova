/**
 * Lets a call through at most once per `gapMs` and drops the rest. For progress ticks, where the
 * latest value matters and the ones in between would only flood the window.
 */
export function throttle<Args extends unknown[]>(
  fn: (...args: Args) => void,
  gapMs: number,
  now: () => number = Date.now,
): (...args: Args) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (...args) => {
    const at = now();
    if (at - last < gapMs) return;
    last = at;
    fn(...args);
  };
}
