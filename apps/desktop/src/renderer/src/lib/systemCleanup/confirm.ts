import { type ProviderScan, planKeepNewest, type ScanItem, summarizePlan } from '@runova/core';
import { formatBytes } from '@/lib/format';

/**
 * The wording of the question asked before anything is removed. Removal is permanent, so the
 * question says what goes, how much it frees at most, that it is not recoverable, what happens
 * next time a tool wants the files, and the two ways "keep the newest" can surprise. It is built
 * here, apart from the page, so the numbers and the caveats are tested.
 */

export interface ConfirmContent {
  title: string;
  description: string;
  items?: { name: string; detail?: string; isDirectory?: boolean }[];
  moreCount?: number;
  warning: string;
  confirmLabel: string;
}

/** How many things the question lists by name before it says "and 4 more". */
const LISTED = 6;

const PERMANENT = 'deleted for good, not moved to the Recycle Bin';

const BEFORE_YOU_GO =
  'Close running builds and dev servers first. "Newest" means the highest version number, which is not always the one a project uses.';

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The biggest few as list rows, and how many more there are. */
function biggestVersions(items: readonly ScanItem[]): Pick<ConfirmContent, 'items' | 'moreCount'> {
  const sorted = [...items].sort((a, b) => b.bytes - a.bytes);
  return {
    items: sorted.slice(0, LISTED).map((entry) => ({
      name: entry.groupLabel,
      detail:
        entry.version === null
          ? formatBytes(entry.bytes)
          : `${entry.version}, ${formatBytes(entry.bytes)}`,
      isDirectory: true,
    })),
    moreCount: Math.max(0, sorted.length - LISTED),
  };
}

function byPackage(items: readonly ScanItem[]): Pick<ConfirmContent, 'items' | 'moreCount'> {
  const groups = new Map<
    string,
    { label: string; bytes: number; count: number; versioned: boolean }
  >();
  for (const entry of items) {
    const existing = groups.get(entry.group);
    if (existing) {
      existing.bytes += entry.bytes;
      existing.count += 1;
      existing.versioned ||= entry.version !== null;
    } else {
      groups.set(entry.group, {
        label: entry.groupLabel,
        bytes: entry.bytes,
        count: 1,
        versioned: entry.version !== null,
      });
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  return {
    items: sorted.slice(0, LISTED).map((group) => ({
      name: group.label,
      detail: `${count(group.count, group.versioned ? 'version' : 'item')}, ${formatBytes(group.bytes)}`,
      isDirectory: true,
    })),
    moreCount: Math.max(0, sorted.length - LISTED),
  };
}

export function oldVersionsConfirm(provider: ProviderScan, keep: number): ConfirmContent | null {
  const { remove } = planKeepNewest(provider.items, { keep });
  if (remove.length === 0) return null;
  const summary = summarizePlan(remove);
  const size = formatBytes(summary.freesUpTo);
  const stays =
    keep === 1
      ? 'The newest version of each package stays.'
      : `The newest ${keep} versions of each package stay.`;
  return {
    title: `Remove old versions from ${provider.label}?`,
    description: `This removes ${count(summary.items, 'version')} of ${count(summary.groups, 'package')} and frees up to ${size}. ${stays} They are ${PERMANENT}.`,
    ...biggestVersions(remove),
    warning: `${provider.afterClearing} ${BEFORE_YOU_GO}`,
    confirmLabel: `Free ${size}`,
  };
}

/** One question for "clean old versions" across every cache that has some. */
export function allOldVersionsConfirm(
  providers: readonly ProviderScan[],
  keep: number,
): ConfirmContent | null {
  const parts = providers
    .map((provider) => ({ provider, remove: planKeepNewest(provider.items, { keep }).remove }))
    .filter((part) => part.remove.length > 0);
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0]) return oldVersionsConfirm(parts[0].provider, keep);

  const all = parts.flatMap((part) => part.remove);
  const summary = summarizePlan(all);
  // Packages are counted per cache, since two caches can hold a package of the same name.
  const packages = parts.reduce((sum, part) => sum + summarizePlan(part.remove).groups, 0);
  const size = formatBytes(summary.freesUpTo);
  const stays =
    keep === 1
      ? 'The newest version of each package stays.'
      : `The newest ${keep} versions of each package stay.`;
  return {
    title: `Remove old versions from ${parts.length} caches?`,
    description: `This removes ${count(summary.items, 'version')} of ${count(packages, 'package')} and frees up to ${size}. ${stays} They are ${PERMANENT}.`,
    items: parts
      .map((part) => ({ part, freed: summarizePlan(part.remove) }))
      .sort((a, b) => b.freed.freesUpTo - a.freed.freesUpTo)
      .slice(0, LISTED)
      .map(({ part, freed }) => ({
        name: part.provider.label,
        detail: `${count(freed.items, 'version')}, ${formatBytes(freed.freesUpTo)}`,
        isDirectory: true,
      })),
    moreCount: Math.max(0, parts.length - LISTED),
    warning: `Tools download what they need again, so the next install or build can be slower. ${BEFORE_YOU_GO}`,
    confirmLabel: `Free ${size}`,
  };
}

export function everythingConfirm(provider: ProviderScan): ConfirmContent {
  const summary = summarizePlan(provider.items);
  const size = formatBytes(summary.freesUpTo);
  return {
    title: `Clear all of ${provider.label}?`,
    description: `This removes everything the scan found in ${provider.root ?? 'the cache folder'} and frees up to ${size}. It is ${PERMANENT}.`,
    ...byPackage(provider.items),
    warning: `${provider.afterClearing} Close running builds and dev servers first.`,
    confirmLabel: `Clear ${size}`,
  };
}

export function itemsConfirm(
  provider: ProviderScan,
  selected: ReadonlySet<string>,
): ConfirmContent | null {
  const picked = provider.items.filter((entry) => selected.has(entry.id));
  if (picked.length === 0) return null;
  const summary = summarizePlan(picked);
  const size = formatBytes(summary.freesUpTo);
  return {
    title: `Delete ${count(picked.length, 'item')}?`,
    description: `This frees up to ${size} from ${provider.label}. It is ${PERMANENT}.`,
    ...biggestVersions(picked),
    warning: `${provider.afterClearing} Close running builds and dev servers first.`,
    confirmLabel: `Delete ${size}`,
  };
}

export function commandConfirm(
  provider: ProviderScan,
  action: { kind: 'tidy' | 'clear-command'; label: string },
): ConfirmContent {
  const size = formatBytes(provider.bytes);
  const what =
    action.kind === 'tidy'
      ? `This runs ${action.label}, which removes only what nothing uses any more. The cache takes ${size} now, and some of it stays.`
      : `This runs ${action.label}, the clean-up ${provider.label} provides for this cache. The cache takes ${size} now. What it removes is ${PERMANENT}.`;
  return {
    title: `Clean ${provider.label} with its own tool?`,
    description: what,
    items: [{ name: action.label, isDirectory: false }],
    warning: provider.afterClearing,
    confirmLabel: 'Run it',
  };
}
