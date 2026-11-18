import type { DurationEstimate } from '@shared/apiTypes';
import { compareToUsual, type LiveEta } from '@shared/pipelineEstimates';
import { ArrowDown, ArrowUp } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { etaText, usualText } from './estimateView';
import { approxDuration, formatMs } from './runStatus';

/**
 * The small pieces that show a pipeline estimate: a progress bar and a countdown for what is
 * running, a hint for what has not started, and a chip for a finished item that was clearly faster
 * or slower than usual. Each one explains on hover what the estimate rests on.
 */

/**
 * How far along a running item is. It fills in the primary colour while on time, turns amber once
 * it runs past the usual time, and is striped when the estimate is only a rough guess.
 */
export function EtaBar({
  eta,
  estimate,
  label,
  size = 'md',
  className,
}: {
  eta: LiveEta;
  estimate: DurationEstimate;
  /** What is running, for the bar's accessible name. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}): React.JSX.Element {
  const over = eta.remainingMs <= 0 && eta.overByMs > 0;
  const percent = Math.round(eta.fraction * 100);
  const rough = estimate.confidence === 'low';

  return (
    <SimpleTooltip label={usualText(estimate)} className="max-w-xs">
      <div
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={etaText(eta)}
        data-state={over ? 'over' : 'on-time'}
        data-confidence={estimate.confidence}
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-foreground/[0.07]',
          size === 'sm' ? 'h-[3px]' : 'h-1',
          className,
        )}
      >
        <div
          data-fill
          className={cn(
            'eta-sheen relative h-full overflow-hidden rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none',
            over
              ? 'bg-gradient-to-r from-warning/70 to-warning'
              : 'bg-gradient-to-r from-primary/60 to-primary',
            rough && 'eta-rough opacity-75',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </SimpleTooltip>
  );
}

/** `~1m 20s left` for a running item, in amber once it runs longer than usual. */
export function EtaText({
  eta,
  estimate,
  className,
}: {
  eta: LiveEta;
  estimate: DurationEstimate;
  className?: string;
}): React.JSX.Element {
  const over = eta.remainingMs <= 0 && eta.overByMs > 0;
  return (
    <SimpleTooltip label={usualText(estimate)} className="max-w-xs">
      <span
        className={cn(
          'shrink-0 whitespace-nowrap text-[11px] tabular-nums',
          over ? 'text-warning' : 'text-muted-foreground',
          className,
        )}
      >
        {etaText(eta)}
      </span>
    </SimpleTooltip>
  );
}

/** Roughly how long something that has not started yet usually takes: `~45s`. */
export function UsualHint({
  estimate,
  className,
}: {
  estimate: DurationEstimate;
  className?: string;
}): React.JSX.Element {
  const approx = approxDuration(estimate.ms);
  return (
    <SimpleTooltip label={usualText(estimate)} className="max-w-xs">
      <span
        aria-label={`Usually about ${approx}`}
        className={cn(
          'shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/60',
          className,
        )}
      >
        {`~${approx}`}
      </span>
    </SimpleTooltip>
  );
}

/**
 * A finished item's time against its usual one, shown only when the difference is clear. `only`
 * keeps it to one direction, for long lists where a fast step is not news.
 */
export function DeltaChip({
  actualMs,
  estimate,
  only,
  className,
}: {
  actualMs: number;
  estimate: DurationEstimate;
  only?: 'slower' | 'faster';
  className?: string;
}): React.JSX.Element | null {
  const comparison = compareToUsual(actualMs, estimate);
  if (comparison.kind === 'usual' || (only && comparison.kind !== only)) return null;
  const slower = comparison.kind === 'slower';
  const amount = formatMs(comparison.deltaMs);
  const Icon = slower ? ArrowUp : ArrowDown;

  return (
    <SimpleTooltip label={usualText(estimate)} className="max-w-xs">
      <span
        aria-label={`${amount} ${comparison.kind} than usual`}
        className={cn(
          'inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 text-[10px] font-medium leading-4 tabular-nums',
          slower ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success',
          className,
        )}
      >
        <Icon className="h-2 w-2" />
        {`${amount} ${comparison.kind}`}
      </span>
    </SimpleTooltip>
  );
}
