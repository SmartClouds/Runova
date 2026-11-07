/**
 * The skill names its run folders run-<N>. A run name crosses IPC from the renderer, so this exact
 * shape is the only thing ever joined onto the runs folder.
 */
const RUN_NAME = /^run-(\d{1,6})$/;

export function isAuditRunName(name: string): boolean {
  return RUN_NAME.test(name);
}

export function auditRunNumber(name: string): number | null {
  const match = RUN_NAME.exec(name);
  return match ? Number(match[1]) : null;
}

/** One past the highest run, so a new run never lands in a folder an older run used. */
export function nextAuditRunName(existing: readonly string[]): string {
  const highest = existing.reduce((max, name) => Math.max(max, auditRunNumber(name) ?? 0), 0);
  return `run-${highest + 1}`;
}
