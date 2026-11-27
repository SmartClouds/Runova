import type { GithubRunJob, GithubRunStep, PipelineConclusion } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import { planRerun } from './rerunPlan';

function step(number: number, conclusion: PipelineConclusion): GithubRunStep {
  return {
    number,
    name: `Step ${number}`,
    status: 'completed',
    conclusion,
    startedAt: conclusion === 'skipped' ? null : '2026-03-15T09:00:00Z',
    completedAt: conclusion === 'skipped' ? null : '2026-03-15T09:00:10Z',
  };
}

function job(
  id: number,
  conclusion: PipelineConclusion,
  steps: GithubRunStep[] = [],
): GithubRunJob {
  return {
    id,
    name: `job-${id}`,
    status: 'completed',
    conclusion,
    startedAt: '2026-03-15T09:00:00Z',
    completedAt: '2026-03-15T09:01:00Z',
    htmlUrl: null,
    runnerName: null,
    steps,
  };
}

const ids = (entries: { job: GithubRunJob }[]) => entries.map((entry) => entry.job.id);

describe('planRerun', () => {
  it('re-runs the jobs that failed, timed out or were cancelled', () => {
    const plan = planRerun(
      [job(1, 'success'), job(2, 'failure'), job(3, 'timed_out'), job(4, 'cancelled')],
      'failed',
    );
    expect(ids(plan.rerun)).toEqual([2, 3, 4]);
  });

  it('says skipped jobs may run again, since GitHub runs them when they need a failed job', () => {
    const plan = planRerun([job(1, 'failure'), job(2, 'skipped')], 'failed');
    expect(ids(plan.maybe)).toEqual([2]);
  });

  it('keeps the result of everything else', () => {
    const plan = planRerun(
      [job(1, 'success'), job(2, 'failure'), job(3, 'neutral'), job(4, 'skipped')],
      'failed',
    );
    expect(ids(plan.kept)).toEqual([1, 3]);
  });

  it('re-runs every job, in GitHub order, when asked for all of them', () => {
    const plan = planRerun(
      [job(1, 'success'), job(2, 'failure'), job(3, 'skipped'), job(4, 'cancelled')],
      'all',
    );
    expect(ids(plan.rerun)).toEqual([1, 2, 3, 4]);
    expect(plan.maybe).toEqual([]);
    expect(plan.kept).toEqual([]);
  });

  it('points at the first step that failed in each job', () => {
    const plan = planRerun(
      [
        job(1, 'failure', [step(1, 'success'), step(2, 'failure'), step(3, 'failure')]),
        job(2, 'cancelled', [step(1, 'success'), step(2, 'cancelled')]),
      ],
      'failed',
    );
    expect(plan.rerun[0]?.failedStep?.number).toBe(2);
    expect(plan.rerun[1]?.failedStep).toBeUndefined();
  });

  it('counts a step that timed out as the one that failed', () => {
    const plan = planRerun(
      [job(1, 'timed_out', [step(1, 'success'), step(2, 'timed_out')])],
      'all',
    );
    expect(plan.rerun[0]?.failedStep?.number).toBe(2);
  });

  it('has nothing to plan when there are no jobs', () => {
    expect(planRerun([], 'failed')).toEqual({ rerun: [], maybe: [], kept: [] });
  });
});
