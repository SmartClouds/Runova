import type {
  CleanupRemoveItem,
  ProjectCleanupScan,
  RestoreHint,
} from '@shared/projectCleanupTypes';

/**
 * The arithmetic behind a project's Cleanup tab: a scan turned into rows, the rows into groups,
 * what is picked, and what picking it frees. It holds no state and touches no window API, so the
 * tab, the Projects page chip and the tests all read the same numbers.
 */

export type CleanupGroupId = 'build' | 'cache' | 'dependencies' | 'studio';

export interface GroupMeta {
  id: CleanupGroupId;
  label: string;
  blurb: string;
  /** Whether "Safe pick" ticks the group: it comes back without anyone doing anything. */
  safe: boolean;
}

/** In the order the list shows them: the ones that cost nothing to lose come first. */
export const GROUPS: readonly GroupMeta[] = [
  {
    id: 'build',
    label: 'Build output',
    blurb: 'Made again the next time you build.',
    safe: true,
  },
  {
    id: 'cache',
    label: 'Caches',
    blurb: 'Tools fill these again when they need them.',
    safe: true,
  },
  {
    id: 'dependencies',
    label: 'Dependencies',
    blurb: 'Installed again by your package manager, which takes a little while.',
    safe: false,
  },
  {
    id: 'studio',
    label: 'Studio render cache',
    blurb: 'Previews and render pieces. Your videos, recordings and generated media stay.',
    safe: true,
  },
];

const META: ReadonlyMap<CleanupGroupId, GroupMeta> = new Map(GROUPS.map((g) => [g.id, g]));

/** One thing that can be deleted, whether it is a folder or a Studio video's cache. */
export interface CleanupRow {
  /** A folder's candidate id, or `studio:<videoId>`. */
  key: string;
  group: CleanupGroupId;
  name: string;
  /** Under the name: the folder's path, or what kind of cache this is. */
  detail: string;
  /** The worktree it is in, or null for the project folder itself. */
  locationLabel: string | null;
  bytes: number;
  /** What deleting it frees: its size less what other names still hold. */
  freeBytes: number;
  sharedBytes: number;
  files: number | null;
  modifiedAt: number | null;
  restore: RestoreHint | null;
  /** Why it cannot be picked, or null. */
  locked: string | null;
  item: CleanupRemoveItem;
}

const STUDIO_RESTORE: RestoreHint = {
  label: 'Comes back the next time the video is previewed or rendered.',
  command: null,
};

export function rowsFromScan(scan: ProjectCleanupScan): CleanupRow[] {
  const rows: CleanupRow[] = [];
  for (const location of scan.locations) {
    for (const c of location.candidates) {
      rows.push({
        key: c.id,
        group: c.category,
        name: c.name,
        detail: c.relPath,
        locationLabel: location.isMain ? null : location.label,
        bytes: c.bytes,
        freeBytes: Math.max(0, c.bytes - c.sharedBytes),
        sharedBytes: c.sharedBytes,
        files: c.files,
        modifiedAt: c.modifiedAt || null,
        restore: c.restore,
        locked: c.locked,
        item: { kind: 'folder', locationId: c.locationId, relPath: c.relPath },
      });
    }
  }
  for (const video of scan.studio) {
    rows.push({
      key: `studio:${video.videoId}`,
      group: 'studio',
      name: video.title,
      detail: 'Render cache',
      locationLabel: null,
      bytes: video.bytes,
      freeBytes: video.bytes,
      sharedBytes: 0,
      files: null,
      modifiedAt: null,
      restore: STUDIO_RESTORE,
      locked: video.busy ? 'A render of this video is running.' : null,
      item: { kind: 'studio', videoId: video.videoId },
    });
  }
  return rows;
}

export interface GroupSummary extends GroupMeta {
  rows: CleanupRow[];
  /** Everything in the group, locked rows included. */
  bytes: number;
  /** What could be freed from it: the rows that are not locked. */
  freeBytes: number;
  selectedCount: number;
  selectedFreeBytes: number;
  lockedCount: number;
  /** For the group's checkbox, judged on the rows that can be picked. */
  state: 'none' | 'some' | 'all';
}

export function groupRows(
  rows: readonly CleanupRow[],
  selected: ReadonlySet<string>,
): GroupSummary[] {
  const summaries: GroupSummary[] = [];
  for (const meta of GROUPS) {
    const inGroup = rows
      .filter((row) => row.group === meta.id)
      .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
    if (inGroup.length === 0) continue;
    const free = inGroup.filter((row) => !row.locked);
    const picked = free.filter((row) => selected.has(row.key));
    summaries.push({
      ...meta,
      rows: inGroup,
      bytes: inGroup.reduce((sum, row) => sum + row.bytes, 0),
      freeBytes: free.reduce((sum, row) => sum + row.freeBytes, 0),
      selectedCount: picked.length,
      selectedFreeBytes: picked.reduce((sum, row) => sum + row.freeBytes, 0),
      lockedCount: inGroup.length - free.length,
      state: picked.length === 0 ? 'none' : picked.length === free.length ? 'all' : 'some',
    });
  }
  return summaries;
}

export type SelectionPreset = 'safe' | 'all' | 'none';

export function presetSelection(rows: readonly CleanupRow[], preset: SelectionPreset): Set<string> {
  if (preset === 'none') return new Set();
  return new Set(
    rows
      .filter((row) => !row.locked && (preset === 'all' || META.get(row.group)?.safe))
      .map((row) => row.key),
  );
}

/** What is ticked when the list first appears: everything that comes back by itself. */
export function defaultSelection(rows: readonly CleanupRow[]): Set<string> {
  return presetSelection(rows, 'safe');
}

/** The group's checkbox: picks every row that can be picked, or clears them when all are. */
export function toggleGroup(
  groupRows: readonly CleanupRow[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  const free = groupRows.filter((row) => !row.locked);
  const allPicked = free.length > 0 && free.every((row) => next.has(row.key));
  for (const row of free) {
    if (allPicked) next.delete(row.key);
    else next.add(row.key);
  }
  return next;
}

export function selectionTotals(
  rows: readonly CleanupRow[],
  selected: ReadonlySet<string>,
): { count: number; freeBytes: number } {
  let count = 0;
  let freeBytes = 0;
  for (const row of rows) {
    if (row.locked || !selected.has(row.key)) continue;
    count += 1;
    freeBytes += row.freeBytes;
  }
  return { count, freeBytes };
}

/** The commands that put back what is picked, each once, for the confirm and the toast. */
export function restoreCommands(
  rows: readonly CleanupRow[],
  selected: ReadonlySet<string>,
): string[] {
  const commands: string[] = [];
  for (const row of rows) {
    const command = row.restore?.command;
    if (row.locked || !selected.has(row.key) || !command || commands.includes(command)) continue;
    commands.push(command);
  }
  return commands;
}

export function toRemoveItems(
  rows: readonly CleanupRow[],
  selected: ReadonlySet<string>,
): CleanupRemoveItem[] {
  return rows.filter((row) => !row.locked && selected.has(row.key)).map((row) => row.item);
}

export type CompositionId = 'own' | 'git' | CleanupGroupId;

export interface CompositionPart {
  id: CompositionId;
  label: string;
  bytes: number;
}

/** What the project's space is made of, for the bar under the headline. Empty parts are left out. */
export function composition(scan: ProjectCleanupScan): CompositionPart[] {
  let total = 0;
  let git = 0;
  const weight: Record<CleanupGroupId, number> = { dependencies: 0, build: 0, cache: 0, studio: 0 };
  for (const location of scan.locations) {
    total += location.totalBytes;
    git += location.gitBytes;
    for (const c of location.candidates) weight[c.category] += c.bytes;
  }
  for (const video of scan.studio) weight.studio += video.bytes;
  const rebuildable = weight.dependencies + weight.build + weight.cache;
  const parts: CompositionPart[] = [
    { id: 'own', label: 'Your files', bytes: Math.max(0, total - git - rebuildable) },
    { id: 'git', label: 'Git history', bytes: git },
    { id: 'dependencies', label: 'Dependencies', bytes: weight.dependencies },
    { id: 'build', label: 'Build output', bytes: weight.build },
    { id: 'cache', label: 'Caches', bytes: weight.cache },
    { id: 'studio', label: 'Studio render cache', bytes: weight.studio },
  ];
  return parts.filter((part) => part.bytes > 0);
}

/** What could be freed in all: every row that is not locked. */
export function reclaimableBytes(scan: ProjectCleanupScan): number {
  return rowsFromScan(scan)
    .filter((row) => !row.locked)
    .reduce((sum, row) => sum + row.freeBytes, 0);
}

/** What the Projects page remembers about a project between visits. */
export interface CleanupSummary {
  scannedAt: number;
  totalBytes: number;
  reclaimableBytes: number;
}

export function summarize(scan: ProjectCleanupScan): CleanupSummary {
  const totalBytes =
    scan.locations.reduce((sum, location) => sum + location.totalBytes, 0) +
    scan.studio.reduce((sum, video) => sum + video.bytes, 0);
  return { scannedAt: scan.scannedAt, totalBytes, reclaimableBytes: reclaimableBytes(scan) };
}

/** The scan as it is once these rows are gone, so the numbers move without scanning again. */
export function withoutRemoved(
  scan: ProjectCleanupScan,
  removed: ReadonlySet<string>,
): ProjectCleanupScan {
  if (removed.size === 0) return scan;
  return {
    ...scan,
    locations: scan.locations.map((location) => {
      const gone = location.candidates.filter((c) => removed.has(c.id));
      if (gone.length === 0) return location;
      return {
        ...location,
        totalBytes: Math.max(0, location.totalBytes - gone.reduce((sum, c) => sum + c.bytes, 0)),
        candidates: location.candidates.filter((c) => !removed.has(c.id)),
      };
    }),
    studio: scan.studio.filter((video) => !removed.has(`studio:${video.videoId}`)),
  };
}
