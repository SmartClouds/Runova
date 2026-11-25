import type {
  DurationEstimate,
  GithubActionsHistoryItem,
  GithubRunJob,
  GithubRunStep,
  RunEstimates,
} from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import {
  estimateFromHistory,
  etaText,
  jobLiveEta,
  runLiveEta,
  stepLiveEta,
  usualText,
} from './estimateView';

const T0 = Date.parse('2026-11-18T10:00:00Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const s = (seconds: number): number => seconds * 1000;

function estimate(ms: number, overrides: Partial<DurationEstimate> = {}): DurationEstimate {
  return { ms, lowMs: ms, highMs: ms, samples: 6, confidence: 'high', ...overrides };
}

function step(overrides: Partial<GithubRunStep> = {}): GithubRunStep {
  return {
    number: 1,
    name: 'Test',
    status: 'in_progress',
    conclusion: null,
    startedAt: at(0),
    completedAt: null,
    ...overrides,
  };
}

function job(overrides: Partial<GithubRunJob> = {}): GithubRunJob {
  return {
    id: 1,
    name: 'build',
    status: 'in_progress',
    conclusion: null,
    startedAt: at(0),
    completedAt: null,
    htmlUrl: null,
    runnerName: null,
    steps: [],
    ...overrides,
  };
}

describe('etaText', () => {
  it('says roughly how long is left', () => {
    expect(etaText({ remainingMs: s(80), overByMs: 0, fraction: 0.5 })).toBe('~1m 20s left');
  });

  it('says how far past the usual time it has gone', () => {
    expect(etaText({ remainingMs: 0, overByMs: s(62), fraction: 0.99 })).toBe(
      '1m longer than usual',
    );
  });

  it('says it is almost done in the last few seconds either way', () => {
    expect(etaText({ remainingMs: s(3), overByMs: 0, fraction: 0.9 })).toBe('almost done');
    expect(etaText({ remainingMs: 0, overByMs: s(2), fraction: 0.99 })).toBe('almost done');
  });
});

describe('usualText', () => {
  it('gives the usual time, its range and what it rests on', () => {
    expect(usualText(estimate(s(190), { lowMs: s(170), highMs: s(210), samples: 8 }))).toBe(
      'Usually 3m 10s (2m 50s to 3m 30s), from 8 passing runs.',
    );
  });

  it('leaves the range out when there is none, and owns up to a rough guess', () => {
    expect(usualText(estimate(s(45), { samples: 1, confidence: 'low' }))).toBe(
      'Usually 45s, from 1 passing run. A rough guess until more runs pass.',
    );
  });
});

describe('stepLiveEta', () => {
  it('counts down a running step', () => {
    expect(stepLiveEta(step(), estimate(s(60)), T0 + s(15))).toEqual({
      remainingMs: s(45),
      overByMs: 0,
      fraction: 0.25,
    });
  });

  it('has nothing for a step that is not running or has no estimate', () => {
    expect(stepLiveEta(step({ status: 'completed' }), estimate(s(60)), T0)).toBeNull();
    expect(stepLiveEta(step({ startedAt: null }), estimate(s(60)), T0)).toBeNull();
    expect(stepLiveEta(step(), undefined, T0)).toBeNull();
  });
});

describe('jobLiveEta', () => {
  const usual = { estimate: estimate(s(100)), steps: {} };

  it('counts down a running job', () => {
    expect(jobLiveEta(job(), usual, T0 + s(25))).toEqual({
      remainingMs: s(75),
      overByMs: 0,
      fraction: 0.25,
    });
  });

  it('has nothing for a queued or finished job, or one never seen before', () => {
    expect(jobLiveEta(job({ status: 'queued', startedAt: null }), usual, T0)).toBeNull();
    expect(jobLiveEta(job({ status: 'completed', completedAt: at(9) }), usual, T0)).toBeNull();
    expect(jobLiveEta(job(), undefined, T0)).toBeNull();
  });
});

describe('runLiveEta', () => {
  const run = { status: 'in_progress' as const };
  const estimates: RunEstimates = {
    runs: 6,
    run: estimate(s(300)),
    jobs: { build: { estimate: estimate(s(100)), steps: {} } },
  };

  it('goes by the usual run while its jobs are on time', () => {
    expect(runLiveEta(run, [job()], estimates, T0 + s(60))?.remainingMs).toBe(s(240));
  });

  it('waits for a job that is running late', () => {
    const first = job({ id: 2, name: 'lint', status: 'completed', completedAt: at(30) });
    const late = job({ startedAt: at(250) });
    expect(runLiveEta(run, [first, late], estimates, T0 + s(260))?.remainingMs).toBe(s(90));
  });

  it('does not count down while the run waits for a runner', () => {
    const queued = job({ status: 'queued', startedAt: at(0) });
    expect(runLiveEta({ status: 'queued' }, [queued], estimates, T0 + s(600))).toBeNull();
    expect(runLiveEta({ status: 'queued' }, [], estimates, T0 + s(600))).toBeNull();
  });

  it('has nothing for a running run until its jobs are read', () => {
    expect(runLiveEta(run, undefined, estimates, T0 + s(60))).toBeNull();
  });

  it('starts the clock when the first job starts, not when the run was made', () => {
    // Created at 0 (or long before, for a re-run), but waited ten minutes for a runner.
    const started = job({ startedAt: at(600) });
    const eta = runLiveEta(run, [started], estimates, T0 + s(660));
    expect(eta?.remainingMs).toBe(s(240));
    expect(eta?.overByMs).toBe(0);
  });

  it('has nothing for a finished run or a pipeline with no passing runs yet', () => {
    expect(runLiveEta({ ...run, status: 'completed' }, [], estimates, T0)).toBeNull();
    expect(runLiveEta(run, [], { runs: 0, run: null, jobs: {} }, T0)).toBeNull();
    expect(runLiveEta(run, undefined, undefined, T0)).toBeNull();
  });
});

describe('estimateFromHistory', () => {
  function item(id: number, overrides: Partial<GithubActionsHistoryItem> = {}) {
    return {
      id,
      projectId: 'p1',
      projectName: 'Aurora',
      repo: 'acme/aurora',
      workflowName: 'CI',
      workflowId: 7,
      displayTitle: `Run ${id}`,
      runNumber: id,
      headBranch: 'main',
      status: 'completed',
      conclusion: 'success',
      htmlUrl: '',
      createdAt: at(id * 1000),
      updatedAt: at(id * 1000 + 120),
      ...overrides,
    } satisfies GithubActionsHistoryItem;
  }

  it("goes by the same workflow's passing runs, leaving the run itself out", () => {
    const live = item(9, { status: 'in_progress', conclusion: null, updatedAt: at(9000) });
    const items = [
      live,
      item(8),
      item(7),
      item(6, { conclusion: 'failure', updatedAt: at(6010) }),
      item(5, { workflowId: 8, updatedAt: at(5900) }),
      item(4, { repo: 'acme/other', updatedAt: at(4900) }),
    ];
    expect(estimateFromHistory(items, live)).toMatchObject({ ms: s(120), samples: 2 });
  });

  it('matches by workflow name when the id is not known', () => {
    const live = item(9, { workflowId: undefined, status: 'in_progress', conclusion: null });
    const items = [live, item(8, { workflowId: undefined }), item(7, { workflowName: 'Docs' })];
    expect(estimateFromHistory(items, live)?.samples).toBe(1);
  });

  it('has nothing without earlier passing runs', () => {
    const live = item(9, { status: 'in_progress', conclusion: null });
    expect(estimateFromHistory([live], live)).toBeNull();
  });
});
