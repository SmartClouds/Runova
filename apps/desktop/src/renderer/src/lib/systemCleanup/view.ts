import {
  CACHE_PROVIDERS,
  type CacheProviderId,
  compareCacheVersions,
  OTHER_GROUP,
  type ProviderKind,
  type ProviderScan,
  planKeepNewest,
  providerReclaimable,
  type ScanItem,
  type ScanProgress,
  type SystemCleanupScan,
  summarizePlan,
  type VolumeUse,
} from '@runova/core';

/**
 * What Disk Cleanup shows, worked out from what a scan found. Everything here is pure: the cards,
 * the figures at the top, the review of one cache and the picking of what to delete. The page only
 * lays these out.
 *
 * Two kinds of knowledge sit side by side. A cache read in this session is "live": its items can
 * be cleaned. One remembered from an earlier session has only a summary, so it is shown for
 * reference and has to be read again (`needsScan`) before anything is done to it.
 */

/** What is kept between runs of the app about a cache that was read properly. */
export interface ProviderSummary {
  id: CacheProviderId;
  label: string;
  tagline: string;
  kind: ProviderKind;
  bytes: number;
  files: number;
  packageCount: number;
  /** What removing all but the newest would free, when it was scanned. */
  reclaimableBytes: number;
  root: string | null;
  scannedAt: number;
  clearLabel: string | null;
  tidyLabel: string | null;
}

function packagesIn(items: readonly ScanItem[]): number {
  return new Set(items.filter((entry) => entry.version !== null).map((entry) => entry.group)).size;
}

export function summaryOf(
  provider: ProviderScan,
  scannedAt: number,
  keep: number,
): ProviderSummary | null {
  if (provider.status !== 'ready') return null;
  return {
    id: provider.id,
    label: provider.label,
    tagline: provider.tagline,
    kind: provider.kind,
    bytes: provider.bytes,
    files: provider.files,
    packageCount: packagesIn(provider.items),
    reclaimableBytes: providerReclaimable(provider, keep),
    root: provider.root,
    scannedAt,
    clearLabel: provider.clearCommand?.label ?? null,
    tidyLabel: provider.tidyCommand?.label ?? null,
  };
}

// --- The cards -----------------------------------------------------------------------------

export type CardState = 'queued' | 'scanning' | 'live' | 'remembered' | 'unverified' | 'error';

export interface CardActions {
  review: boolean;
  cleanOld: boolean;
  clearAll: boolean;
  /** The tool's own command, for a cache only its tool cleans. */
  tool: { kind: 'tidy' | 'clear-command'; label: string } | null;
}

export interface CardModel {
  id: CacheProviderId;
  label: string;
  tagline: string;
  kind: ProviderKind;
  state: CardState;
  bytes: number;
  files: number;
  packageCount: number;
  reclaimableBytes: number;
  root: string | null;
  /** When a remembered cache was read. */
  scannedAt: number | null;
  /** True when the cache has to be read again before anything is done to it. */
  needsScan: boolean;
  /** Something the person should know, such as why a cache is not offered. */
  note: string | null;
  actions: CardActions;
}

const NO_ACTIONS: CardActions = { review: false, cleanOld: false, clearAll: false, tool: null };
const TOOL_NOT_INSTALLED = 'Only its own tool cleans this cache, and that tool is not installed.';

function toolAction(
  tidy: string | null | undefined,
  clear: string | null | undefined,
): CardActions['tool'] {
  if (tidy) return { kind: 'tidy', label: tidy };
  if (clear) return { kind: 'clear-command', label: clear };
  return null;
}

function liveCard(provider: ProviderScan, keep: number): CardModel {
  const base = {
    id: provider.id,
    label: provider.label,
    tagline: provider.tagline,
    kind: provider.kind,
    bytes: provider.bytes,
    files: provider.files,
    root: provider.root,
    scannedAt: null,
    needsScan: false,
  };

  if (provider.status === 'unverified' || provider.status === 'error') {
    return {
      ...base,
      state: provider.status,
      packageCount: 0,
      reclaimableBytes: 0,
      note:
        provider.error ??
        (provider.status === 'error' ? 'It could not be read.' : 'Nothing in it is offered.'),
      actions: NO_ACTIONS,
    };
  }

  if (provider.kind === 'opaque') {
    const tool = toolAction(provider.tidyCommand?.label, provider.clearCommand?.label);
    return {
      ...base,
      state: 'live',
      packageCount: 0,
      reclaimableBytes: 0,
      note: tool ? null : TOOL_NOT_INSTALLED,
      actions: { ...NO_ACTIONS, tool },
    };
  }

  const reclaimable = providerReclaimable(provider, keep);
  const hasItems = provider.items.length > 0;
  return {
    ...base,
    state: 'live',
    packageCount: packagesIn(provider.items),
    reclaimableBytes: reclaimable,
    note: null,
    actions: {
      review: hasItems,
      cleanOld: reclaimable > 0,
      clearAll: hasItems && provider.bytes > 0,
      tool: null,
    },
  };
}

function rememberedCard(summary: ProviderSummary): CardModel {
  const versioned = summary.kind === 'versioned';
  const tool = toolAction(summary.tidyLabel, summary.clearLabel);
  return {
    id: summary.id,
    label: summary.label,
    tagline: summary.tagline,
    kind: summary.kind,
    state: 'remembered',
    bytes: summary.bytes,
    files: summary.files,
    packageCount: summary.packageCount,
    reclaimableBytes: summary.reclaimableBytes,
    root: summary.root,
    scannedAt: summary.scannedAt,
    needsScan: true,
    note: versioned || tool ? null : TOOL_NOT_INSTALLED,
    actions: versioned
      ? {
          review: summary.bytes > 0,
          cleanOld: summary.reclaimableBytes > 0,
          clearAll: summary.bytes > 0,
          tool: null,
        }
      : { ...NO_ACTIONS, tool },
  };
}

function waitingCard(
  id: CacheProviderId,
  state: 'queued' | 'scanning',
  bytes: number,
  files: number,
): CardModel {
  const info = CACHE_PROVIDERS.find((provider) => provider.id === id);
  return {
    id,
    label: info?.label ?? id,
    tagline: info?.tagline ?? '',
    kind: info?.kind ?? 'versioned',
    state,
    bytes,
    files,
    packageCount: 0,
    reclaimableBytes: 0,
    root: null,
    scannedAt: null,
    needsScan: false,
    note: null,
    actions: NO_ACTIONS,
  };
}

export interface CardModelInput {
  /** The scan held by the main process, from this session. */
  scan: SystemCleanupScan | null;
  /** What a scan under way has found so far. */
  progress: ScanProgress;
  summaries: Readonly<Partial<Record<CacheProviderId, ProviderSummary>>>;
  keep: number;
}

export function cardModels(input: CardModelInput): { cards: CardModel[]; absent: string[] } {
  const { scan, progress, summaries, keep } = input;
  const ids: CacheProviderId[] = [];
  const add = (id: CacheProviderId): void => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const id of progress.order) add(id);
  for (const provider of scan?.providers ?? []) add(provider.id);
  for (const id of Object.keys(summaries) as CacheProviderId[]) add(id);

  const cards: CardModel[] = [];
  const absent: string[] = [];

  for (const id of ids) {
    const inRun = progress.running ? progress.providers[id] : undefined;
    if (inRun && (inRun.status === 'queued' || inRun.status === 'scanning')) {
      cards.push(waitingCard(id, inRun.status, inRun.bytes, inRun.files));
      continue;
    }

    const result = inRun?.result ?? scan?.providers.find((provider) => provider.id === id) ?? null;
    if (result?.status === 'missing') {
      absent.push(result.label);
      continue;
    }
    if (result && result.status !== 'cancelled' && result.status !== 'queued') {
      cards.push(liveCard(result, keep));
      continue;
    }

    const summary = summaries[id];
    if (summary) cards.push(rememberedCard(summary));
  }
  return { cards, absent };
}

// --- Sorting and filtering ----------------------------------------------------------------

export type CardSort = 'size' | 'reclaimable' | 'name';
export type CardTab = 'all' | 'free' | 'tool';

export function sortCards(cards: readonly CardModel[], by: CardSort): CardModel[] {
  const sorted = [...cards];
  if (by === 'name') return sorted.sort((a, b) => a.label.localeCompare(b.label));
  if (by === 'reclaimable') {
    return sorted.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes || b.bytes - a.bytes);
  }
  return sorted.sort((a, b) => b.bytes - a.bytes);
}

export function filterCards(
  cards: readonly CardModel[],
  filter: { tab: CardTab; query: string },
): CardModel[] {
  const query = filter.query.trim().toLowerCase();
  return cards.filter((card) => {
    if (filter.tab === 'free' && card.reclaimableBytes <= 0) return false;
    if (filter.tab === 'tool' && card.kind !== 'opaque') return false;
    if (!query) return true;
    return `${card.label} ${card.tagline}`.toLowerCase().includes(query);
  });
}

// --- The figures at the top ---------------------------------------------------------------

export interface OverviewPart {
  id: CacheProviderId | 'others';
  label: string;
  bytes: number;
}

export interface Overview {
  totalBytes: number;
  totalFiles: number;
  packageCount: number;
  reclaimableBytes: number;
  cachesFound: number;
  /** True when every figure is from an earlier session. */
  remembered: boolean;
  /** When the oldest remembered figure was read. */
  scannedAt: number | null;
  /** Where the space goes, largest first. */
  parts: OverviewPart[];
  /** The disk the caches take most of. */
  volume: VolumeUse | null;
}

/** More caches than this are folded into one "everything else" so the bar and its key stay legible. */
const MOST_PARTS = 7;

export function overview(cards: readonly CardModel[], volumes: readonly VolumeUse[]): Overview {
  let totalBytes = 0;
  let totalFiles = 0;
  let packageCount = 0;
  let reclaimableBytes = 0;
  let cachesFound = 0;
  let scannedAt: number | null = null;

  for (const card of cards) {
    totalBytes += card.bytes;
    totalFiles += card.files;
    packageCount += card.packageCount;
    reclaimableBytes += card.reclaimableBytes;
    if (card.bytes > 0) cachesFound += 1;
    if (card.scannedAt !== null) scannedAt = Math.min(scannedAt ?? card.scannedAt, card.scannedAt);
  }

  const sized: OverviewPart[] = cards
    .filter((card) => card.bytes > 0)
    .map((card) => ({ id: card.id, label: card.label, bytes: card.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  let parts = sized;
  if (sized.length > MOST_PARTS) {
    const rest = sized.slice(MOST_PARTS - 1);
    parts = [
      ...sized.slice(0, MOST_PARTS - 1),
      {
        id: 'others',
        label: 'Everything else',
        bytes: rest.reduce((sum, part) => sum + part.bytes, 0),
      },
    ];
  }

  const volume = [...volumes].sort((a, b) => b.cacheBytes - a.cacheBytes)[0] ?? null;

  return {
    totalBytes,
    totalFiles,
    packageCount,
    reclaimableBytes,
    cachesFound,
    remembered: cards.length > 0 && cards.every((card) => card.state === 'remembered'),
    scannedAt,
    parts,
    volume,
  };
}

// --- The review of one cache --------------------------------------------------------------

export interface ReviewVersion {
  id: string;
  version: string | null;
  bytes: number;
  sharedBytes: number;
  files: number;
  newestMs: number;
  /** Kept when old versions are removed, because it is one of the newest. */
  kept: boolean;
}

export interface ReviewGroup {
  key: string;
  label: string;
  versions: ReviewVersion[];
  bytes: number;
  reclaimableBytes: number;
  hasOld: boolean;
  /** Its versions could not be put in order, so none are offered for removal by version. */
  unordered: boolean;
}

export function reviewGroups(provider: ProviderScan, keep: number): ReviewGroup[] {
  const plan = planKeepNewest(provider.items, { keep });
  const removed = new Set(plan.remove.map((entry) => entry.id));
  const unordered = new Set(plan.skipped.map((skip) => skip.group));

  const byGroup = new Map<string, ScanItem[]>();
  for (const entry of provider.items) {
    const members = byGroup.get(entry.group);
    if (members) members.push(entry);
    else byGroup.set(entry.group, [entry]);
  }

  const groups: ReviewGroup[] = [];
  for (const [key, members] of byGroup) {
    const versioned = members
      .filter((entry) => entry.version !== null)
      .sort((a, b) => compareCacheVersions(b.version ?? '', a.version ?? ''));
    const unversioned = members.filter((entry) => entry.version === null);
    const versions = [...versioned, ...unversioned].map(
      (entry): ReviewVersion => ({
        id: entry.id,
        version: entry.version,
        bytes: entry.bytes,
        sharedBytes: entry.sharedBytes,
        files: entry.files,
        newestMs: entry.newestMs,
        kept: !removed.has(entry.id),
      }),
    );
    const reclaimableBytes = versions
      .filter((version) => !version.kept)
      .reduce((sum, version) => sum + version.bytes - version.sharedBytes, 0);
    groups.push({
      key,
      label: members[0]?.groupLabel ?? key,
      versions,
      bytes: members.reduce((sum, entry) => sum + entry.bytes, 0),
      reclaimableBytes,
      hasOld: versions.some((version) => !version.kept),
      unordered: unordered.has(key),
    });
  }

  const rank = (group: ReviewGroup): number => (group.key === OTHER_GROUP ? 1 : 0);
  return groups.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.reclaimableBytes - a.reclaimableBytes ||
      b.bytes - a.bytes ||
      a.label.localeCompare(b.label),
  );
}

export function filterGroups(groups: readonly ReviewGroup[], query: string): ReviewGroup[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...groups];
  return groups.filter((group) => `${group.label} ${group.key}`.toLowerCase().includes(wanted));
}

// --- Picking what to delete ---------------------------------------------------------------

export type SelectionPreset = 'old' | 'all' | 'none';

export function defaultSelection(provider: ProviderScan, keep: number): Set<string> {
  return new Set(planKeepNewest(provider.items, { keep }).remove.map((entry) => entry.id));
}

export function presetSelection(
  provider: ProviderScan,
  keep: number,
  preset: SelectionPreset,
): Set<string> {
  if (preset === 'all') return new Set(provider.items.map((entry) => entry.id));
  if (preset === 'none') return new Set();
  return defaultSelection(provider, keep);
}

export function groupState(
  group: ReviewGroup,
  selected: ReadonlySet<string>,
): 'none' | 'some' | 'all' {
  const picked = group.versions.filter((version) => selected.has(version.id)).length;
  if (picked === 0) return 'none';
  return picked === group.versions.length ? 'all' : 'some';
}

export function toggleGroup(group: ReviewGroup, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const clearing = groupState(group, selected) === 'all';
  for (const version of group.versions) {
    if (clearing) next.delete(version.id);
    else next.add(version.id);
  }
  return next;
}

export function toggleItem(id: string, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

export interface SelectionTotals {
  count: number;
  bytes: number;
  freesUpTo: number;
  groups: number;
}

export function selectionTotals(
  provider: ProviderScan,
  selected: ReadonlySet<string>,
): SelectionTotals {
  const summary = summarizePlan(provider.items.filter((entry) => selected.has(entry.id)));
  return {
    count: summary.items,
    bytes: summary.bytes,
    freesUpTo: summary.freesUpTo,
    groups: summary.groups,
  };
}
