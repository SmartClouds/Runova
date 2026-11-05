/** Marks the copy "Keep both" adds, so the person can tell the two apart. */
export function fromAnotherComputer(name: unknown, max = Number.POSITIVE_INFINITY): string {
  const suffix = ' (from another computer)';
  return `${String(name ?? '').slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}
