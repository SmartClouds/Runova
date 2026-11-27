import type { GithubRunJob, GithubRunRerunRequest, GithubRunStep } from '@shared/apiTypes';
import { runTone } from './runStatus';

export type RerunScope = GithubRunRerunRequest['scope'];

/** One job in the plan, with the step it broke on last time when there was one. */
export interface PlannedJob {
  job: GithubRunJob;
  failedStep?: GithubRunStep;
}

/**
 * What a re-run will do to each job of the run, worked out from how the jobs ended:
 * - `rerun`: jobs that start again for sure.
 * - `maybe`: jobs that were skipped last time. GitHub re-runs the jobs that need a failed one too,
 *   and a job that needed a failed job was skipped, but a job can also be skipped by its own `if`.
 *   Without the workflow's `needs` graph there is no telling which, so they only may run.
 * - `kept`: jobs whose result stays as it is.
 * Each group keeps GitHub's order.
 */
export interface RerunPlan {
  rerun: PlannedJob[];
  maybe: PlannedJob[];
  kept: PlannedJob[];
}

function planned(job: GithubRunJob): PlannedJob {
  const failedStep = job.steps.find((step) => runTone(step).outcome === 'failed');
  return failedStep ? { job, failedStep } : { job };
}

export function planRerun(jobs: GithubRunJob[], scope: RerunScope): RerunPlan {
  const plan: RerunPlan = { rerun: [], maybe: [], kept: [] };
  for (const job of jobs) {
    const entry = planned(job);
    if (scope === 'all') {
      plan.rerun.push(entry);
      continue;
    }
    const tone = runTone(job);
    if (tone.outcome === 'failed' || tone.outcome === 'cancelled') plan.rerun.push(entry);
    else if (tone.label === 'Skipped') plan.maybe.push(entry);
    else plan.kept.push(entry);
  }
  return plan;
}
