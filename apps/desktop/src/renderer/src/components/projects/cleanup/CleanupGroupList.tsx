import { useId } from 'react';
import {
  Bolt,
  Check,
  Clapperboard,
  GitBranch,
  Lock,
  Package,
  Spinner,
  TriangleAlert,
  Wrench,
} from '@/components/icons';
import { Chip, GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import type { CleanupGroupId, CleanupRow, GroupSummary } from '@/lib/projectCleanup/selection';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * The folders a scan found, grouped by how they come back. Each group is a card with a checkbox
 * that picks all of it; each row says what the folder is, how big, how many files, how long since
 * anything changed, and the command that puts it back, so nobody has to guess what a click does.
 * Locked rows are shown with their reason instead of being hidden.
 */

export interface RowStatus {
  status: 'removing' | 'done' | 'failed';
  freedBytes?: number;
  error?: string;
}

export interface CleanupGroupListProps {
  groups: GroupSummary[];
  selected: ReadonlySet<string>;
  statuses: Readonly<Record<string, RowStatus>>;
  /** True while a scan or a removal runs, when nothing can be picked. */
  disabled: boolean;
  /** For "changed 3h ago", so a test can fix the clock. */
  now?: number;
  onToggleRow: (key: string) => void;
  onToggleGroup: (group: GroupSummary) => void;
  onRetry: (key: string) => void;
}

const GROUP_ICON: Record<CleanupGroupId, React.ComponentType<{ className?: string }>> = {
  build: Wrench,
  cache: Bolt,
  dependencies: Package,
  studio: Clapperboard,
};

function rowLabel(row: CleanupRow): string {
  const base = row.group === 'studio' ? row.name : row.detail;
  return row.locationLabel ? `${base} in ${row.locationLabel}` : base;
}

/** `apps/web/node_modules` as a dim `apps/web/` and a plain `node_modules`. */
function splitPath(path: string): { parent: string; leaf: string } {
  const cut = path.lastIndexOf('/');
  return { parent: path.slice(0, cut + 1), leaf: path.slice(cut + 1) };
}

export function CleanupGroupList({
  groups,
  selected,
  statuses,
  disabled,
  now = Date.now(),
  onToggleRow,
  onToggleGroup,
  onRetry,
}: CleanupGroupListProps): React.JSX.Element {
  const biggest = Math.max(1, ...groups.flatMap((group) => group.rows.map((row) => row.bytes)));

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          biggest={biggest}
          selected={selected}
          statuses={statuses}
          disabled={disabled}
          now={now}
          onToggleRow={onToggleRow}
          onToggleGroup={onToggleGroup}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

function GroupCard({
  group,
  biggest,
  selected,
  statuses,
  disabled,
  now,
  onToggleRow,
  onToggleGroup,
  onRetry,
}: Omit<CleanupGroupListProps, 'groups' | 'now'> & {
  group: GroupSummary;
  biggest: number;
  now: number;
}): React.JSX.Element {
  const Icon = GROUP_ICON[group.id];
  const nothingToPick = group.rows.length === group.lockedCount;

  return (
    <section aria-label={group.label} className={cn(GLASS_CARD, 'overflow-hidden')}>
      <header className="flex items-start gap-3 p-4 pb-3">
        <Checkbox
          aria-label={`Select all in ${group.label}`}
          className="mt-2"
          checked={group.state === 'all' ? true : group.state === 'some' ? 'indeterminate' : false}
          disabled={disabled || nothingToPick}
          onCheckedChange={() => onToggleGroup(group)}
        />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{group.label}</h3>
            <Chip>{group.rows.length}</Chip>
          </div>
          <p className="text-xs text-muted-foreground">{group.blurb}</p>
        </div>
        <p className="shrink-0 pt-0.5 text-right text-sm tabular-nums">
          <span className="font-semibold">{formatBytes(group.freeBytes)}</span>{' '}
          <span className="text-xs text-muted-foreground">to free</span>
        </p>
      </header>

      <ul>
        {group.rows.map((row, index) => (
          <RowItem
            key={row.key}
            row={row}
            first={index === 0}
            biggest={biggest}
            checked={selected.has(row.key)}
            status={statuses[row.key]}
            disabled={disabled}
            now={now}
            onToggle={() => onToggleRow(row.key)}
            onRetry={() => onRetry(row.key)}
          />
        ))}
      </ul>
    </section>
  );
}

function RowItem({
  row,
  first,
  biggest,
  checked,
  status,
  disabled,
  now,
  onToggle,
  onRetry,
}: {
  row: CleanupRow;
  first: boolean;
  biggest: number;
  checked: boolean;
  status: RowStatus | undefined;
  disabled: boolean;
  now: number;
  onToggle: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const id = useId();
  const locked = row.locked !== null;
  const busy = status?.status === 'removing';
  const { parent, leaf } =
    row.group === 'studio' ? { parent: '', leaf: row.name } : splitPath(row.detail);
  const command = row.restore?.command ?? null;

  return (
    <li
      className={cn(
        'flex items-start gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.03]',
        !first && 'shadow-[inset_0_1px_0_hsl(var(--foreground)/0.07)]',
        (locked || status?.status === 'done') && 'opacity-70',
      )}
    >
      <Checkbox
        id={id}
        aria-label={`Select ${rowLabel(row)}`}
        className="mt-0.5"
        checked={checked && !locked}
        disabled={disabled || locked || busy}
        onCheckedChange={onToggle}
      />

      <div className="min-w-0 flex-1 space-y-1">
        <label
          htmlFor={id}
          className={cn(
            'flex min-w-0 items-baseline gap-0.5 text-sm',
            locked || disabled ? 'cursor-default' : 'cursor-pointer',
          )}
        >
          {parent && (
            <span className="truncate font-mono text-xs text-muted-foreground">{parent}</span>
          )}
          <span
            className={cn(
              'truncate',
              row.group === 'studio' ? 'font-medium' : 'font-mono font-medium',
            )}
          >
            {leaf}
          </span>
          {row.group === 'studio' && (
            <span className="ml-2 text-xs text-muted-foreground">{row.detail}</span>
          )}
        </label>

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {row.locationLabel && (
            <Chip>
              <GitBranch />
              {row.locationLabel}
            </Chip>
          )}
          {row.files !== null && (
            <span className="tabular-nums">
              {row.files.toLocaleString('en-US')} {row.files === 1 ? 'file' : 'files'}
            </span>
          )}
          {row.modifiedAt !== null && (
            <span className="tabular-nums">changed {shortAge(row.modifiedAt, now)} ago</span>
          )}
          {row.sharedBytes > 0 && (
            <SimpleTooltip
              label="Some of its files are shared with a package store, so deleting the folder frees less than its size."
              wrapTrigger
            >
              <span className="tabular-nums text-warning">
                frees about {formatBytes(row.freeBytes)}
              </span>
            </SimpleTooltip>
          )}
          {command && !locked && (
            <SimpleTooltip label={row.restore?.label} wrapTrigger>
              <Chip className="font-mono">{command}</Chip>
            </SimpleTooltip>
          )}
        </div>

        {locked && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <Lock className="mt-px h-3 w-3 shrink-0" />
            <span>{row.locked}</span>
          </p>
        )}
        {status?.status === 'failed' && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
              <span>{status.error}</span>
            </p>
            <Button
              size="xs"
              variant="soft"
              onClick={onRetry}
              aria-label={`Try again: ${rowLabel(row)}`}
            >
              Try again
            </Button>
          </div>
        )}
      </div>

      <div className="w-24 shrink-0 space-y-1.5 text-right sm:w-28">
        {status?.status === 'removing' ? (
          <p className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
            <Spinner className="h-3 w-3 motion-safe:animate-spin" />
            Deleting
          </p>
        ) : status?.status === 'done' ? (
          <p className="flex items-center justify-end gap-1.5 text-xs text-success">
            <Check className="h-3 w-3" />
            Freed {formatBytes(status.freedBytes ?? 0)}
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold tabular-nums">{formatBytes(row.bytes)}</p>
            <div
              aria-hidden="true"
              className="ml-auto h-1 w-full overflow-hidden rounded-full bg-foreground/[0.07]"
            >
              <div
                data-testid="size-bar"
                className="h-full rounded-full bg-primary/70 transition-[width] duration-500 motion-reduce:transition-none"
                style={{ width: `${Math.max(2, Math.round((row.bytes / biggest) * 100))}%` }}
              />
            </div>
          </>
        )}
      </div>
    </li>
  );
}
