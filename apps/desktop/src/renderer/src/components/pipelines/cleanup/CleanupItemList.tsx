import type {
  RunnerCleanupGroup,
  RunnerCleanupItem,
  RunnerCleanupItemOutcome,
  RunnerCleanupRunnerStatus,
} from '@shared/apiTypes';
import { useId } from 'react';
import {
  CircleCheck,
  CircleX,
  Clock,
  Docker,
  Package,
  Server,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Chip, type ChipTone } from '@/components/pageKit/Chip';
import { Checkbox } from '@/components/ui/checkbox';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { groupPickState, toggleGroup, toggleItem } from './cleanupView';

const STATUS: Record<RunnerCleanupRunnerStatus, { label: string; tone: ChipTone; hint: string }> = {
  busy: {
    label: 'Busy',
    tone: 'warning',
    hint: 'Its work folder is left alone until the job ends.',
  },
  idle: { label: 'Idle', tone: 'success', hint: 'No job is running on it.' },
  unknown: {
    label: 'Not checked',
    tone: 'neutral',
    hint: 'GitHub could not say whether this runner is still registered.',
  },
  'not-on-github': { label: 'Not on GitHub', tone: 'destructive', hint: '' },
  'not-configured': { label: 'Never registered', tone: 'destructive', hint: '' },
};

const GROUP_ICON = {
  runner: Server,
  docker: Docker,
  caches: Package,
  abandoned: TriangleAlert,
} as const;

function Outcome({
  item,
  outcome,
  running,
}: {
  item: RunnerCleanupItem;
  outcome: RunnerCleanupItemOutcome | undefined;
  running: boolean;
}): React.JSX.Element | null {
  if (running) {
    return (
      <span role="status" aria-label={`Cleaning ${item.label}`} className="text-muted-foreground">
        <Spinner className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (!outcome) return null;
  if (outcome.status === 'done') {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium text-success">
        <CircleCheck className="h-3 w-3" />
        {`Freed ${formatBytes(outcome.freedBytes)}`}
      </span>
    );
  }
  const Icon = outcome.status === 'skipped' ? Clock : CircleX;
  return (
    <span
      className={cn(
        'flex min-w-0 items-start gap-1 text-[11px]',
        outcome.status === 'skipped' ? 'text-muted-foreground' : 'text-destructive',
      )}
    >
      <Icon className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">{outcome.error}</span>
    </span>
  );
}

function ItemRow({
  item,
  picked,
  locked,
  outcome,
  running,
  onToggle,
}: {
  item: RunnerCleanupItem;
  picked: boolean;
  locked: boolean;
  outcome: RunnerCleanupItemOutcome | undefined;
  running: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const id = useId();
  const disabled = locked || Boolean(item.disabledReason);
  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors',
        !disabled && 'hover:bg-foreground/[0.035]',
        item.disabledReason && 'opacity-70',
      )}
    >
      <Checkbox
        id={id}
        checked={picked && !item.disabledReason}
        disabled={disabled}
        onCheckedChange={onToggle}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <label
            htmlFor={id}
            className={cn('text-[13px] font-medium leading-snug', !disabled && 'cursor-pointer')}
          >
            {item.label}
          </label>
          {item.risk === 'slows' ? (
            <SimpleTooltip label="Nothing breaks, but the next job that needs it is slower while it downloads or builds it again.">
              <span>
                <Chip tone="neutral" className="cursor-help">
                  Downloads again
                </Chip>
              </span>
            </SimpleTooltip>
          ) : null}
          {item.risk === 'careful' ? <Chip tone="destructive">Removes the runner</Chip> : null}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{item.why}</p>
        {item.disabledReason ? (
          <p className="flex items-center gap-1 text-[11px] text-warning">
            <Clock className="h-3 w-3 shrink-0" />
            {item.disabledReason}
          </p>
        ) : null}
        <Outcome item={item} outcome={outcome} running={running} />
      </div>
      <span className="shrink-0 pt-0.5 text-xs font-medium tabular-nums text-foreground">
        {formatBytes(item.bytes)}
      </span>
    </li>
  );
}

/** The scan's findings, grouped by runner, Docker, caches and gone runners, each with a size. */
export function CleanupItemList({
  groups,
  picks,
  onPicksChange,
  outcomes,
  running,
  locked,
}: {
  groups: RunnerCleanupGroup[];
  picks: Set<string>;
  onPicksChange: (picks: Set<string>) => void;
  outcomes: Record<string, RunnerCleanupItemOutcome>;
  running: Set<string>;
  /** True while a cleanup runs: nothing can be picked then. */
  locked: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const Icon = GROUP_ICON[group.kind];
        const state = groupPickState(group, picks);
        const usable = group.items.some((item) => !item.disabledReason);
        const total = group.items.reduce((sum, item) => sum + item.bytes, 0);
        const status = group.status ? STATUS[group.status] : null;
        return (
          <section
            key={group.id}
            role="group"
            aria-label={group.title}
            className={cn(
              'overflow-hidden rounded-xl ring-1 ring-inset',
              group.kind === 'abandoned'
                ? 'bg-destructive/[0.035] ring-destructive/25'
                : 'bg-foreground/[0.02] ring-foreground/[0.08]',
            )}
          >
            <header className="flex items-center gap-3 border-b border-foreground/[0.06] px-3 py-2.5">
              <Checkbox
                checked={state === 'all' ? true : state === 'some' ? 'indeterminate' : false}
                disabled={locked || !usable}
                onCheckedChange={() => onPicksChange(toggleGroup(group, picks))}
                aria-label={`Pick everything in ${group.title}`}
              />
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                  group.kind === 'abandoned'
                    ? 'bg-destructive/12 text-destructive'
                    : 'bg-primary/12 text-primary',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-semibold">{group.title}</span>
                  {status ? (
                    status.hint ? (
                      <SimpleTooltip label={status.hint} className="max-w-xs">
                        <span>
                          <Chip tone={status.tone} dot className="cursor-help">
                            {status.label}
                          </Chip>
                        </span>
                      </SimpleTooltip>
                    ) : (
                      <Chip tone={status.tone} dot>
                        {status.label}
                      </Chip>
                    )
                  ) : null}
                </div>
                {group.subtitle ? (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {group.subtitle}
                  </span>
                ) : null}
              </div>
              <span className="shrink-0 text-xs font-semibold tabular-nums">
                {formatBytes(total)}
              </span>
            </header>
            <ul className="flex flex-col p-1">
              {group.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  picked={picks.has(item.id)}
                  locked={locked}
                  outcome={outcomes[item.id]}
                  running={running.has(item.id)}
                  onToggle={() => onPicksChange(toggleItem(item.id, picks))}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
