import type { ProviderScan } from '@runova/core';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FolderOpen,
  Package,
  Spinner,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import {
  Chip,
  EmptyState,
  GLASS_CARD,
  NoMatches,
  PillTabs,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import {
  defaultSelection,
  filterGroups,
  groupState,
  presetSelection,
  type ReviewGroup,
  type ReviewVersion,
  reviewGroups,
  type SelectionPreset,
  selectionTotals,
  toggleGroup,
  toggleItem,
} from '@/lib/systemCleanup/view';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { ItemStatus } from '@/stores/systemCleanupStore';
import { ProviderMark } from './ProviderMark';

/**
 * One cache, package by package. Every old version starts picked and the newest of each package
 * starts left alone, so "Delete" does what "Clean old versions" would, but the person can look
 * first, open a package, and change any pick. Totals sit in a bar that follows the scroll and
 * puts the size on the button, so it is never just "Delete".
 */

export interface ReviewViewProps {
  provider: ProviderScan;
  keep: number;
  /** What happened to each version in a clean-up, by `cache/item`. */
  statuses: Readonly<Record<string, ItemStatus>>;
  /** A scan or a clean-up is running, when nothing can be changed. */
  busy: boolean;
  /** How far a clean-up of this cache has got. */
  cleaning: { processed: number; total: number } | null;
  /** For "changed 3d ago", so a test can fix the clock. */
  now?: number;
  onKeepChange: (keep: number) => void;
  onBack: () => void;
  onReveal: () => void;
  onDelete: (picked: ReadonlySet<string>) => void;
  onRetry: (itemId: string) => void;
}

/** More than this many packages at once make the list slow to draw and to scroll. */
const PAGE = 50;

const KEEP_CHOICES = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
];

const PRESETS: { id: SelectionPreset; label: string }[] = [
  { id: 'old', label: 'Old versions' },
  { id: 'all', label: 'Select all' },
  { id: 'none', label: 'Select none' },
];

function versionLabel(group: ReviewGroup, version: ReviewVersion): string {
  return version.version === null ? group.label : `${group.label} ${version.version}`;
}

export function ReviewView({
  provider,
  keep,
  statuses,
  busy,
  cleaning,
  now = Date.now(),
  onKeepChange,
  onBack,
  onReveal,
  onDelete,
  onRetry,
}: ReviewViewProps): React.JSX.Element {
  const statusOf = (itemId: string): ItemStatus | undefined => statuses[`${provider.id}/${itemId}`];

  const groups = useMemo(() => reviewGroups(provider, keep), [provider, keep]);
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(provider, keep));
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        groups
          .filter((group) =>
            group.versions.some((v) => statuses[`${provider.id}/${v.id}`]?.status === 'failed'),
          )
          .map((group) => group.key),
      ),
  );

  // Changing how many to keep starts the picking over, with the new default.
  const lastKeep = useRef(keep);
  useEffect(() => {
    if (lastKeep.current === keep) return;
    lastKeep.current = keep;
    setSelected(defaultSelection(provider, keep));
  }, [keep, provider]);

  // Versions that have gone since the picks were made cannot stay picked.
  useEffect(() => {
    const present = new Set(provider.items.map((entry) => entry.id));
    setSelected((previous) => {
      const kept = [...previous].filter((id) => present.has(id));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  }, [provider.items]);

  // A package with a version that could not go opens, so the reason is not hidden away.
  useEffect(() => {
    const failing = groups
      .filter((group) =>
        group.versions.some((v) => statuses[`${provider.id}/${v.id}`]?.status === 'failed'),
      )
      .map((group) => group.key);
    if (failing.length === 0) return;
    setOpen((previous) => {
      if (failing.every((key) => previous.has(key))) return previous;
      return new Set([...previous, ...failing]);
    });
  }, [groups, statuses, provider.id]);

  const visible = useMemo(() => filterGroups(groups, query), [groups, query]);
  const totals = selectionTotals(provider, selected);
  const listId = useId();

  const toggleOpen = (key: string): void =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <header className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 p-4')}>
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft />
          All caches
        </Button>
        <ProviderMark id={provider.id} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{provider.label}</h2>
          <div className="flex min-w-0 items-center gap-1">
            {provider.root && (
              <>
                <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                  {provider.root}
                </code>
                <CopyButton text={provider.root} label="Copy path" alwaysVisible />
                <SimpleTooltip label="Show in folder">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Show ${provider.label} in its folder`}
                    onClick={onReveal}
                  >
                    <FolderOpen />
                  </Button>
                </SimpleTooltip>
              </>
            )}
          </div>
        </div>
        <p className="text-2xl font-semibold tabular-nums tracking-tight">
          {formatBytes(provider.bytes)}
        </p>
      </header>

      {groups.length === 0 ? (
        <EmptyState
          card
          icon={Package}
          title="Nothing to review"
          description="This cache is empty."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchPill
              className="w-full sm:w-72"
              label="Search packages"
              type="search"
              placeholder="Search packages"
              clearLabel="Clear search"
              value={query}
              onValueChange={(value) => {
                setQuery(value);
                setShown(PAGE);
              }}
            />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                {PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setSelected(presetSelection(provider, keep, preset.id))}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Keep newest</span>
                <PillTabs
                  id="review-keep"
                  label="Versions to keep"
                  kind="toggle"
                  size="xs"
                  items={KEEP_CHOICES}
                  value={String(keep)}
                  onChange={(value) => onKeepChange(Number(value))}
                />
              </div>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className={GLASS_CARD}>
              <NoMatches query={query} />
            </div>
          ) : (
            <div className={cn(GLASS_CARD, 'overflow-hidden')}>
              <ul aria-label="Packages" id={listId}>
                {visible.slice(0, shown).map((group, index) => (
                  <GroupRow
                    key={group.key}
                    group={group}
                    first={index === 0}
                    open={open.has(group.key)}
                    selected={selected}
                    busy={busy}
                    now={now}
                    statusOf={statusOf}
                    onToggleOpen={() => toggleOpen(group.key)}
                    onToggleGroup={() => setSelected((previous) => toggleGroup(group, previous))}
                    onToggleItem={(id) => setSelected((previous) => toggleItem(id, previous))}
                    onRetry={onRetry}
                  />
                ))}
              </ul>
              {visible.length > shown && (
                <div className="flex justify-center p-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => setShown((count) => count + PAGE)}
                  >
                    Show {Math.min(PAGE, visible.length - shown)} more
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <ActionBar
        count={totals.count}
        freesUpTo={totals.freesUpTo}
        busy={busy}
        cleaning={cleaning}
        onClear={() => setSelected(new Set())}
        onDelete={() => onDelete(selected)}
      />
    </div>
  );
}

function GroupRow({
  group,
  first,
  open,
  selected,
  busy,
  now,
  statusOf,
  onToggleOpen,
  onToggleGroup,
  onToggleItem,
  onRetry,
}: {
  group: ReviewGroup;
  first: boolean;
  open: boolean;
  selected: ReadonlySet<string>;
  busy: boolean;
  now: number;
  statusOf: (itemId: string) => ItemStatus | undefined;
  onToggleOpen: () => void;
  onToggleGroup: () => void;
  onToggleItem: (id: string) => void;
  onRetry: (itemId: string) => void;
}): React.JSX.Element {
  const panel = useId();
  const state = groupState(group, selected);
  const single = group.versions.length === 1;

  return (
    <li className={cn(!first && 'shadow-[inset_0_1px_0_hsl(var(--foreground)/0.07)]')}>
      <div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-foreground/[0.03]">
        <Checkbox
          aria-label={`Select all versions of ${group.label}`}
          checked={state === 'all' ? true : state === 'some' ? 'indeterminate' : false}
          disabled={busy}
          onCheckedChange={onToggleGroup}
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          aria-label={`${open ? 'Hide' : 'Show'} versions of ${group.label}`}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          <span className="truncate font-mono text-sm font-medium">{group.label}</span>
          {single && group.versions[0]?.kept ? (
            <Chip>Latest only</Chip>
          ) : (
            <>
              <Chip>
                {group.versions.length} {group.versions.length === 1 ? 'version' : 'versions'}
              </Chip>
              {group.hasOld ? (
                <Chip tone="primary">Can free {formatBytes(group.reclaimableBytes)}</Chip>
              ) : (
                <Chip tone="success">
                  <Check />
                  All kept
                </Chip>
              )}
            </>
          )}
        </button>
        <p className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">
          {formatBytes(group.bytes)}
        </p>
      </div>

      {open && (
        <div id={panel} className="bg-foreground/[0.02] pb-1">
          {group.unordered && (
            <p className="flex items-start gap-1.5 px-4 py-1.5 pl-[3.25rem] text-xs text-warning">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
              <span>Could not tell which is newest, so none of these is picked by default.</span>
            </p>
          )}
          <ul aria-label={`Versions of ${group.label}`}>
            {group.versions.map((version, index) => (
              <VersionRow
                key={version.id}
                group={group}
                version={version}
                newest={index === 0 && version.kept && !group.unordered}
                checked={selected.has(version.id)}
                busy={busy}
                now={now}
                status={statusOf(version.id)}
                onToggle={() => onToggleItem(version.id)}
                onRetry={() => onRetry(version.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function VersionRow({
  group,
  version,
  newest,
  checked,
  busy,
  now,
  status,
  onToggle,
  onRetry,
}: {
  group: ReviewGroup;
  version: ReviewVersion;
  newest: boolean;
  checked: boolean;
  busy: boolean;
  now: number;
  status: ItemStatus | undefined;
  onToggle: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const label = versionLabel(group, version);
  return (
    <li className="flex items-start gap-3 px-4 py-1.5 pl-[3.25rem]">
      <Checkbox
        aria-label={`Select ${label}`}
        className="mt-0.5"
        checked={checked}
        disabled={busy}
        onCheckedChange={onToggle}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {version.version === null ? (
            <span className="text-sm italic text-muted-foreground">No version</span>
          ) : (
            <span className="font-mono text-sm">{version.version}</span>
          )}
          {newest ? (
            <Chip tone="success">
              <Check />
              Newest, kept
            </Chip>
          ) : version.kept ? (
            <Chip>Kept</Chip>
          ) : null}
          {version.newestMs > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              changed {shortAge(version.newestMs, now)} ago
            </span>
          )}
          {version.sharedBytes > 0 && (
            <SimpleTooltip
              label="Some of its files are shared with another folder, so deleting it frees less than its size."
              wrapTrigger
            >
              <span className="text-xs tabular-nums text-warning">
                frees about {formatBytes(version.bytes - version.sharedBytes)}
              </span>
            </SimpleTooltip>
          )}
        </div>
        {status?.status === 'failed' && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
              <span>{status.reason}</span>
            </p>
            <Button size="xs" variant="soft" aria-label={`Try again: ${label}`} onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
      </div>
      <div className="w-20 shrink-0 text-right">
        {status?.status === 'done' ? (
          <p className="flex items-center justify-end gap-1.5 text-xs text-success">
            <Check className="h-3 w-3" />
            Freed {formatBytes(status.bytes ?? 0)}
          </p>
        ) : (
          <p className="text-sm tabular-nums">{formatBytes(version.bytes)}</p>
        )}
      </div>
    </li>
  );
}

function ActionBar({
  count,
  freesUpTo,
  busy,
  cleaning,
  onClear,
  onDelete,
}: {
  count: number;
  freesUpTo: number;
  busy: boolean;
  cleaning: { processed: number; total: number } | null;
  onClear: () => void;
  onDelete: () => void;
}): React.JSX.Element | null {
  if (count === 0 && !cleaning) return null;
  const total = cleaning?.total ?? 0;
  const done = cleaning?.processed ?? 0;

  return (
    <section
      aria-label="Selected versions"
      className={cn(
        // Opaque, so the list scrolling underneath does not show through the text.
        'glass-opaque sticky bottom-3 z-10 mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 rounded-full px-4 py-2.5',
        'shadow-[0_12px_32px_-12px_hsl(0_0%_0%/0.45)]',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3',
      )}
    >
      {cleaning ? (
        <div className="min-w-0 flex-1 space-y-1.5">
          <p role="status" className="text-sm font-medium tabular-nums">
            {done} of {total} deleted
          </p>
          <div
            role="progressbar"
            aria-label="Deleting"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            className="h-1 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
          >
            <div
              className="h-full origin-left rounded-full bg-primary transition-transform duration-300 motion-reduce:transition-none"
              style={{ transform: `scaleX(${total === 0 ? 0 : done / total})` }}
            />
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium tabular-nums">
            {count === 1 ? '1 item selected' : `${count} items selected`}
          </p>
          <p className="text-xs text-muted-foreground">Frees up to {formatBytes(freesUpTo)}</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
          Clear
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={onDelete}>
          {cleaning ? (
            <>
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              Deleting
            </>
          ) : (
            <>
              <Trash2 className="h-3.5 w-3.5" />
              Delete {formatBytes(freesUpTo)}
            </>
          )}
        </Button>
      </div>
    </section>
  );
}
