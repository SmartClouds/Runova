import { compareCacheVersions, isStableVersion, parseCacheVersion } from './versions.js';

/**
 * Deciding what a clean-up removes. A plan only names items from a scan; nothing here touches a
 * disk. The rule that matters is "keep the newest": it keeps the newest few versions of each
 * package, and also the newest stable one, and it leaves a package alone altogether when its
 * versions cannot be put in order, because removing the wrong copy is worse than removing none.
 */

export interface PlanItem {
  id: string;
  group: string;
  groupLabel: string;
  version: string | null;
  bytes: number;
  sharedBytes: number;
}

export interface PlanSkip {
  group: string;
  label: string;
  reason: string;
}

export interface KeepPlan<T extends PlanItem = PlanItem> {
  remove: T[];
  keep: T[];
  skipped: PlanSkip[];
}

const MOST_TO_KEEP = 9;
const UNORDERED = 'The versions could not be put in order, so none were removed.';

function keepCount(asked: number): number {
  if (!Number.isFinite(asked)) return 1;
  return Math.min(MOST_TO_KEEP, Math.max(1, Math.floor(asked)));
}

export function planKeepNewest<T extends PlanItem>(
  items: readonly T[],
  options: { keep: number },
): KeepPlan<T> {
  const groups = new Map<string, T[]>();
  const unversioned: T[] = [];
  for (const entry of items) {
    if (entry.version === null) {
      unversioned.push(entry);
      continue;
    }
    const members = groups.get(entry.group);
    if (members) members.push(entry);
    else groups.set(entry.group, [entry]);
  }

  const wanted = keepCount(options.keep);
  const plan: KeepPlan<T> = { remove: [], keep: [], skipped: [] };

  for (const [group, members] of groups) {
    const unreadable = members.some((member) => parseCacheVersion(member.version ?? '') === null);
    if (unreadable) {
      plan.keep.push(...members);
      if (members.length > 1) {
        plan.skipped.push({ group, label: members[0]?.groupLabel ?? group, reason: UNORDERED });
      }
      continue;
    }

    // Oldest first. The sort is stable, so equal versions keep the order they came in.
    const sorted = [...members].sort((a, b) =>
      compareCacheVersions(a.version ?? '', b.version ?? ''),
    );
    const cutoff = sorted[Math.max(0, sorted.length - wanted)]?.version ?? '';
    const newestStable = [...sorted]
      .reverse()
      .find((member) => isStableVersion(member.version ?? ''));

    for (const member of sorted) {
      const version = member.version ?? '';
      const atOrAboveCutoff = compareCacheVersions(version, cutoff) >= 0;
      const isNewestStable =
        newestStable !== undefined &&
        compareCacheVersions(version, newestStable.version ?? '') === 0;
      if (atOrAboveCutoff || isNewestStable) plan.keep.push(member);
      else plan.remove.push(member);
    }
  }

  plan.keep.push(...unversioned);
  return plan;
}

export function planEverything<T extends PlanItem>(items: readonly T[]): KeepPlan<T> {
  return { remove: [...items], keep: [], skipped: [] };
}

export function planSelection<T extends PlanItem>(
  items: readonly T[],
  ids: readonly string[],
): { remove: T[]; unknown: string[] } {
  const wanted = new Set(ids);
  const remove = items.filter((entry) => wanted.has(entry.id));
  const known = new Set(items.map((entry) => entry.id));
  return { remove, unknown: [...wanted].filter((id) => !known.has(id)) };
}

export interface PlanSummary {
  items: number;
  groups: number;
  bytes: number;
  /** Bytes in files another name also points at, which deleting these items does not free. */
  sharedBytes: number;
  /** The most this can free. */
  freesUpTo: number;
}

export function summarizePlan(remove: readonly PlanItem[]): PlanSummary {
  let bytes = 0;
  let sharedBytes = 0;
  const groups = new Set<string>();
  for (const entry of remove) {
    bytes += entry.bytes;
    sharedBytes += entry.sharedBytes;
    groups.add(entry.group);
  }
  return {
    items: remove.length,
    groups: groups.size,
    bytes,
    sharedBytes,
    freesUpTo: bytes - sharedBytes,
  };
}
