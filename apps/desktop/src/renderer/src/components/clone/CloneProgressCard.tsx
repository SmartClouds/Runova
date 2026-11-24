import type { CloneJob } from '@shared/apiTypes';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { durationText } from '@/components/deploy/files/copy';
import { CircleCheck, CircleX, Github, RefreshCw, StopCircle, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ProgressBar, type ProgressTone } from '@/components/ui/progress-bar';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { clonePhaseLabel, cloneTransferText, PHASE_MARKS } from '@/lib/cloneJobText';
import { cn } from '@/lib/utils';
import { cancelClone, dismissClone, useCloneJobsStore } from '@/stores/cloneJobsStore';
import { runClone } from './runClone';

/**
 * One background clone, as a strip at the foot of a project card (`compact`) or as a card of its
 * own on the Git tab and in the status bar panel (`full`). It follows the job through every state:
 * the bar fills while git works (with notches where git moves on to its next step), turns green
 * when it is done, red with the reason when it fails, and grey when the user stopped it.
 */

const TONE: Record<CloneJob['status'], ProgressTone> = {
  running: 'primary',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'muted',
};

function cloneTitle(job: CloneJob): string {
  const repo = job.repoLabel;
  switch (job.status) {
    case 'succeeded':
      return job.attach ? `Connected to ${repo}` : `Cloned ${repo}`;
    case 'failed':
      return job.attach ? `Couldn't connect to ${repo}` : `Couldn't clone ${repo}`;
    case 'cancelled':
      return job.attach ? `Stopped connecting to ${repo}` : `Stopped cloning ${repo}`;
    default:
      return job.attach ? `Connecting to ${repo}` : `Cloning ${repo}`;
  }
}

/** The line under the title: the step and the download while it runs, the outcome after. */
function statusLine(job: CloneJob): string {
  if (job.status === 'failed') return job.message || 'Clone failed.';
  if (job.status === 'cancelled') {
    return job.attach ? 'The folder was left as it was.' : 'The folder was left empty.';
  }
  if (job.status === 'succeeded') return 'Ready on this computer.';
  return clonePhaseLabel(job);
}

/** Seconds since the clone started, ticking once a second while it runs. */
function useElapsed(job: CloneJob): string | null {
  const running = job.status === 'running';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = now - job.startedAt;
  return running && elapsed >= 3000 ? durationText(elapsed) : null;
}

function StatusIcon({ job, size }: { job: CloneJob; size: 'sm' | 'md' }): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const Icon =
    job.status === 'succeeded' ? CircleCheck : job.status === 'failed' ? CircleX : Github;
  return (
    <motion.span
      // A new key per state, so the check (or cross) pops in when the job lands.
      key={job.status}
      aria-hidden
      initial={reduceMotion || job.status === 'running' ? false : { scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 520, damping: 26 }}
      className={cn(
        'flex shrink-0 items-center justify-center',
        size === 'md' ? 'h-8 w-8 rounded-lg [&_svg]:size-4' : 'h-4 w-4 [&_svg]:size-3',
        size === 'md' && job.status === 'running' && 'bg-primary/12 text-primary',
        size === 'md' && job.status === 'succeeded' && 'bg-success/12 text-success',
        size === 'md' && job.status === 'failed' && 'bg-destructive/12 text-destructive',
        size === 'md' && job.status === 'cancelled' && 'bg-foreground/[0.06] text-muted-foreground',
        size === 'sm' && job.status === 'running' && 'text-primary',
        size === 'sm' && job.status === 'succeeded' && 'text-success',
        size === 'sm' && job.status === 'failed' && 'text-destructive',
        size === 'sm' && job.status === 'cancelled' && 'text-muted-foreground',
      )}
    >
      <Icon />
    </motion.span>
  );
}

function retry(job: CloneJob): void {
  void runClone({ projectId: job.projectId, repoUrl: job.repoUrl, attach: job.attach });
}

export function CloneProgressCard({
  job,
  variant,
  onOpen,
  className,
}: {
  job: CloneJob;
  variant: 'compact' | 'full';
  /** Shown as "Open project" once the clone is done, for places outside the project. */
  onOpen?: () => void;
  className?: string;
}): React.JSX.Element {
  const showCard = useCloneJobsStore((state) => state.showCard);
  useEffect(() => showCard(job.id), [showCard, job.id]);

  const title = cloneTitle(job);
  const phase = clonePhaseLabel(job);
  const transfer = cloneTransferText(job);
  const elapsed = useElapsed(job);
  const running = job.status === 'running';
  const over = job.status === 'failed' || job.status === 'cancelled';
  const percent = Math.round(job.percent);
  const said = job.status === 'failed' ? job.message || phase : phase;

  const bar = (
    <ProgressBar
      value={job.status === 'cancelled' ? job.percent : running ? job.percent : 100}
      label={title}
      valueText={running ? `${phase}, ${percent}%` : phase}
      tone={TONE[job.status]}
      size={variant === 'full' ? 'md' : 'sm'}
      marks={running ? PHASE_MARKS : undefined}
      live={running}
    />
  );

  const live = (
    <span data-testid="clone-live" aria-live="polite" className="sr-only">
      {`${title}: ${said}`}
    </span>
  );

  const stopButton = running ? (
    <SimpleTooltip label="Stop" side="top">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Stop ${title.charAt(0).toLowerCase()}${title.slice(1)}`}
        onClick={() => void cancelClone(job.id)}
        className="-my-1 h-5 w-5 hover:bg-destructive/10 hover:text-destructive"
      >
        <X />
      </Button>
    </SimpleTooltip>
  ) : null;

  if (variant === 'compact') {
    return (
      <div
        data-clone-status={job.status}
        className={cn('flex flex-col gap-1.5', className)}
        // Clicks here (Stop, Try again) shouldn't also open the card they sit in.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {live}
        <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
          <StatusIcon job={job} size="sm" />
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}
            title={job.status === 'failed' ? job.message : undefined}
          >
            <span className={cn('font-medium', running && 'text-foreground/85')}>
              {job.status === 'failed' ? job.message || phase : phase}
            </span>
            {transfer ? <span className="tabular-nums">{` · ${transfer}`}</span> : null}
          </span>
          {running ? (
            <span className="font-semibold tabular-nums text-foreground/85">{`${percent}%`}</span>
          ) : null}
          {stopButton}
          {over ? (
            <>
              <SimpleTooltip label="Try again" side="top">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Try again"
                  onClick={() => retry(job)}
                  className="-my-1 h-5 w-5"
                >
                  <RefreshCw />
                </Button>
              </SimpleTooltip>
              <SimpleTooltip label="Dismiss" side="top">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss"
                  onClick={() => void dismissClone(job.id)}
                  className="-my-1 h-5 w-5"
                >
                  <X />
                </Button>
              </SimpleTooltip>
            </>
          ) : null}
        </div>
        {bar}
      </div>
    );
  }

  return (
    <section
      aria-label={title}
      data-clone-status={job.status}
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-card/60 p-3.5 transition-colors',
        job.status === 'failed' ? 'border-destructive/30' : 'border-border/70',
        className,
      )}
    >
      {live}
      <div className="flex min-w-0 items-start gap-3">
        <StatusIcon job={job} size="md" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</p>
            {running ? (
              <span className="text-sm font-semibold tabular-nums text-primary">{`${percent}%`}</span>
            ) : null}
          </div>
          <p
            className={cn(
              'flex min-w-0 flex-wrap gap-x-1.5 text-xs',
              job.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            <span className={cn(running && 'font-medium text-foreground/80')}>
              {statusLine(job)}
            </span>
            {transfer ? <span className="tabular-nums">{`· ${transfer}`}</span> : null}
          </p>
        </div>
      </div>
      {bar}
      {running || over || (job.status === 'succeeded' && onOpen) ? (
        <div className="flex items-center justify-end gap-2">
          {elapsed ? (
            <span className="mr-auto text-[11px] tabular-nums text-muted-foreground">
              {`${elapsed} so far`}
            </span>
          ) : null}
          {running ? (
            <Button
              variant="soft"
              size="xs"
              shape="pill"
              aria-label={`Stop ${title.charAt(0).toLowerCase()}${title.slice(1)}`}
              onClick={() => void cancelClone(job.id)}
              className="hover:text-destructive"
            >
              <StopCircle /> Stop
            </Button>
          ) : null}
          {over ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                shape="pill"
                onClick={() => void dismissClone(job.id)}
              >
                Dismiss
              </Button>
              <Button variant="tint" size="xs" shape="pill" onClick={() => retry(job)}>
                <RefreshCw /> Try again
              </Button>
            </>
          ) : null}
          {job.status === 'succeeded' && onOpen ? (
            <Button variant="tint" size="xs" shape="pill" onClick={onOpen}>
              Open project
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
