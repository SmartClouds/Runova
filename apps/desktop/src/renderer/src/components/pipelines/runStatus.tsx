import type { GithubActionsHistoryItem } from '@shared/apiTypes';
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Minus,
  Play,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { cn } from '@/lib/utils';

/** The buckets a run is filtered and coloured by, collapsed from GitHub's status + conclusion pair. */
export type RunOutcome = 'running' | 'queued' | 'passed' | 'failed' | 'cancelled' | 'other';

export interface RunTone {
  outcome: RunOutcome;
  label: string;
  variant: 'success' | 'destructive' | 'warning' | 'outline';
  /** A run that passed but left warning annotations. It still filters as passed. */
  warned?: boolean;
}

type RunLike = Pick<GithubActionsHistoryItem, 'status' | 'conclusion'>;

export function runTone(item: RunLike): RunTone {
  if (item.status !== 'completed') {
    if (item.status === 'queued' || item.status === 'waiting' || item.status === 'pending') {
      return { outcome: 'queued', label: 'Queued', variant: 'warning' };
    }
    return { outcome: 'running', label: 'Running', variant: 'warning' };
  }
  if (item.conclusion === 'success') {
    return { outcome: 'passed', label: 'Passed', variant: 'success' };
  }
  if (item.conclusion === 'failure') {
    return { outcome: 'failed', label: 'Failed', variant: 'destructive' };
  }
  if (item.conclusion === 'timed_out') {
    return { outcome: 'failed', label: 'Timed out', variant: 'destructive' };
  }
  if (item.conclusion === 'cancelled') {
    return { outcome: 'cancelled', label: 'Cancelled', variant: 'outline' };
  }
  if (item.conclusion === 'skipped') {
    return { outcome: 'other', label: 'Skipped', variant: 'outline' };
  }
  return { outcome: 'other', label: item.conclusion ?? item.status, variant: 'outline' };
}

/** Recolours a passed run that left warnings. Failures keep their red, whatever else they left. */
export function withWarnings(tone: RunTone, warningCount: number): RunTone {
  if (tone.outcome !== 'passed' || warningCount <= 0) return tone;
  return { ...tone, label: 'Passed with warnings', variant: 'warning', warned: true };
}

/** The coloured strip down the left edge of a run card. */
export function runStripeClass(tone: RunTone): string {
  if (tone.outcome === 'failed') return 'bg-destructive';
  if (tone.warned) return 'bg-warning';
  if (tone.outcome === 'passed') return 'bg-success';
  if (tone.outcome === 'running' || tone.outcome === 'queued') return 'bg-warning';
  return 'bg-muted-foreground/40';
}

/** True while GitHub can still be asked to stop the run. */
export function isLiveRun(item: Pick<RunLike, 'status'>): boolean {
  return item.status !== 'completed';
}

/** The round status glyph shown at the start of a run row. */
export function RunStatusIcon({
  tone,
  className,
}: {
  tone: RunTone;
  className?: string;
}): React.JSX.Element {
  const icon =
    tone.outcome === 'failed' || tone.warned ? (
      <TriangleAlert className="h-3.5 w-3.5" />
    ) : tone.outcome === 'running' ? (
      <Play className="h-3.5 w-3.5" />
    ) : tone.outcome === 'queued' ? (
      <Clock className="h-3.5 w-3.5" />
    ) : tone.outcome === 'passed' ? (
      <CircleCheck className="h-3.5 w-3.5" />
    ) : (
      <Ban className="h-3.5 w-3.5" />
    );

  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        tone.outcome === 'failed'
          ? 'bg-destructive/12 text-destructive'
          : tone.warned
            ? 'bg-warning/12 text-warning'
            : tone.outcome === 'passed'
              ? 'bg-success/12 text-success'
              : tone.outcome === 'running' || tone.outcome === 'queued'
                ? 'bg-warning/12 text-warning'
                : 'bg-foreground/[0.06] text-muted-foreground',
        className,
      )}
    >
      {icon}
    </span>
  );
}

/** A step's own glyph. The words are for screen readers, since colour alone says too little. */
export function StepGlyph({ tone }: { tone: RunTone }): React.JSX.Element {
  const size = 'h-3.5 w-3.5 shrink-0';
  const icon =
    tone.outcome === 'running' ? (
      <Spinner className={cn(size, 'animate-spin text-warning motion-reduce:animate-none')} />
    ) : tone.outcome === 'failed' ? (
      <CircleX className={cn(size, 'text-destructive')} />
    ) : tone.outcome === 'passed' ? (
      <CircleCheck className={cn(size, 'text-success')} />
    ) : tone.outcome === 'queued' ? (
      <Clock className={cn(size, 'text-muted-foreground')} />
    ) : (
      <Minus className={cn(size, 'text-muted-foreground/60')} />
    );
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {icon}
      <span className="sr-only">{tone.label}</span>
    </span>
  );
}

/**
 * The time between two ISO timestamps as `45s`, `1m 5s` or `2h 2m`. Empty when either end is
 * missing or the pair makes no sense. With `now`, an open end counts up to that clock, for a job
 * or step that is still running.
 */
export function spanDuration(
  start: string | null | undefined,
  end: string | null | undefined,
  now?: number,
): string {
  if (!start) return '';
  const started = Date.parse(start);
  const ended = end ? Date.parse(end) : now;
  if (ended === undefined || !Number.isFinite(started) || !Number.isFinite(ended)) return '';
  return formatMs(ended - started);
}

/** A length of time as `45s`, `1m 5s` or `2h 2m`. Empty when it makes no sense. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A length of time as an estimate reads it, rounded so it does not look more exact than it is:
 * to five seconds under a minute, ten seconds under ten minutes, then minutes, and five minutes
 * once it runs to hours.
 */
export function approxDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 57.5) return `${Math.max(5, Math.round(seconds / 5) * 5)}s`;
  if (seconds < 595) {
    const total = Math.round(seconds / 10) * 10;
    const rest = total % 60;
    return rest ? `${Math.floor(total / 60)}m ${rest}s` : `${total / 60}m`;
  }
  if (seconds < 3570) return `${Math.round(seconds / 60)}m`;
  const minutes = Math.round(seconds / 300) * 5;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`;
}

/** How long a run took, or how long it has been going. Empty when the timestamps make no sense. */
export function runDuration(
  item: Pick<GithubActionsHistoryItem, 'createdAt' | 'updatedAt'>,
): string {
  return spanDuration(item.createdAt, item.updatedAt);
}
