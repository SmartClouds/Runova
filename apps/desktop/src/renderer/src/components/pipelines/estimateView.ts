import type {
  DurationEstimate,
  GithubActionsHistoryItem,
  GithubRunJob,
  GithubRunStep,
  GithubWorkflowRunInfo,
  JobEstimate,
  RunEstimates,
} from '@shared/apiTypes';
import {
  estimateDuration,
  jobRemainingMs,
  type LiveEta,
  liveEta,
  runRemainingMs,
  spanMs,
} from '@shared/pipelineEstimates';
import { approxDuration, formatMs, isLiveRun } from './runStatus';

/** Under this, "~3s left" would claim more than an estimate can know. */
const ALMOST_MS = 5000;

/** What a running item's estimate says, in words: `~1m 20s left`, or how far over it has run. */
export function etaText(eta: LiveEta): string {
  if (eta.remainingMs >= ALMOST_MS) return `~${approxDuration(eta.remainingMs)} left`;
  if (eta.overByMs >= ALMOST_MS) return `${approxDuration(eta.overByMs)} longer than usual`;
  return 'almost done';
}

/** Where an estimate comes from, for its tooltip. */
export function usualText(estimate: DurationEstimate): string {
  const range =
    estimate.lowMs !== estimate.highMs
      ? ` (${formatMs(estimate.lowMs)} to ${formatMs(estimate.highMs)})`
      : '';
  const runs = `${estimate.samples} passing run${estimate.samples === 1 ? '' : 's'}`;
  const rough = estimate.confidence === 'low' ? ' A rough guess until more runs pass.' : '';
  return `Usually ${formatMs(estimate.ms)}${range}, from ${runs}.${rough}`;
}

function since(start: string, now: number): number {
  return Math.max(now - Date.parse(start), 0);
}

/** Where a running step stands against its usual time, or null when that cannot be said. */
export function stepLiveEta(
  step: GithubRunStep,
  estimate: DurationEstimate | undefined,
  now: number,
): LiveEta | null {
  if (!estimate || step.status !== 'in_progress' || !step.startedAt) return null;
  const elapsed = since(step.startedAt, now);
  return liveEta(elapsed, estimate.ms - elapsed, estimate.ms);
}

/** Where a running job stands, going by its steps where they are known. */
export function jobLiveEta(
  job: GithubRunJob,
  usual: JobEstimate | undefined,
  now: number,
): LiveEta | null {
  if (!usual || job.status !== 'in_progress' || !job.startedAt) return null;
  return liveEta(since(job.startedAt, now), jobRemainingMs(job, usual, now), usual.estimate.ms);
}

/**
 * Where a live run stands: its usual time, unless one of its jobs is running so late that the run
 * cannot finish before it does.
 */
export function runLiveEta(
  run: Pick<GithubWorkflowRunInfo, 'status' | 'createdAt'>,
  jobs: GithubRunJob[] | undefined,
  estimates: RunEstimates | undefined,
  now: number,
): LiveEta | null {
  if (!estimates?.run || !isLiveRun(run)) return null;
  const elapsed = since(run.createdAt, now);
  const jobsLeft = (jobs ?? []).flatMap((job) => {
    const usual = estimates.jobs[job.name];
    return usual ? [jobRemainingMs(job, usual, now)] : [];
  });
  return liveEta(elapsed, runRemainingMs(estimates.run.ms, elapsed, jobsLeft), estimates.run.ms);
}

/**
 * A run's usual time from the run history already on screen, for a list row that has no jobs to
 * go by: the same workflow's passing runs (by id, or by name when the id is not known), newest
 * first, leaving the run itself out.
 */
export function estimateFromHistory(
  items: GithubActionsHistoryItem[],
  item: GithubActionsHistoryItem,
): DurationEstimate | null {
  const sameWorkflow = (other: GithubActionsHistoryItem): boolean =>
    item.workflowId !== undefined
      ? other.workflowId === item.workflowId
      : other.workflowName === item.workflowName;
  const samples = items
    .filter(
      (other) =>
        other.id !== item.id &&
        other.repo === item.repo &&
        other.conclusion === 'success' &&
        sameWorkflow(other),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .flatMap((other) => {
      const ms = spanMs(other.createdAt, other.updatedAt);
      return ms === null ? [] : [ms];
    });
  return estimateDuration(samples);
}
