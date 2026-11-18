import { describe, expect, it } from 'vitest';
import type { DurationEstimate, GithubRunJob, GithubRunStep } from './apiTypes';
import {
  buildRunEstimates,
  compareToUsual,
  estimateDuration,
  jobRemainingMs,
  liveEta,
  runRemainingMs,
  stepKeys,
} from './pipelineEstimates';

const T0 = Date.parse('2026-11-18T10:00:00Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const s = (seconds: number): number => seconds * 1000;

function step(overrides: Partial<GithubRunStep> & Pick<GithubRunStep, 'name'>): GithubRunStep {
  return {
    number: 1,
    status: 'completed',
    conclusion: 'success',
    startedAt: at(0),
    completedAt: at(10),
    ...overrides,
  };
}

function job(overrides: Partial<GithubRunJob> & Pick<GithubRunJob, 'name'>): GithubRunJob {
  return {
    id: 1,
    status: 'completed',
    conclusion: 'success',
    startedAt: at(0),
    completedAt: at(60),
    htmlUrl: null,
    runnerName: null,
    steps: [],
    ...overrides,
  };
}

function estimate(ms: number, overrides: Partial<DurationEstimate> = {}): DurationEstimate {
  return { ms, lowMs: ms, highMs: ms, samples: 5, confidence: 'high', ...overrides };
}

describe('estimateDuration', () => {
  it('has nothing to say without samples', () => {
    expect(estimateDuration([])).toBeNull();
  });

  it('takes a single sample as it is, with low confidence', () => {
    expect(estimateDuration([s(90)])).toEqual({
      ms: s(90),
      lowMs: s(90),
      highMs: s(90),
      samples: 1,
      confidence: 'low',
    });
  });

  it('lands on the middle of steady runs, not their mean', () => {
    const result = estimateDuration([s(100), s(102), s(98), s(101), s(99), s(160)]);
    expect(result?.ms).toBeGreaterThanOrEqual(s(99));
    expect(result?.ms).toBeLessThanOrEqual(s(101));
  });

  it('leans towards the newest runs when the pipeline has drifted', () => {
    // Newest first: the last three runs got slower.
    const result = estimateDuration([s(200), s(200), s(200), s(100), s(100), s(100), s(100)]);
    expect(result?.ms).toBe(s(200));
  });

  it('leaves out one run that hung far beyond the others', () => {
    const result = estimateDuration([s(60), s(62), s(900), s(61), s(59), s(60)]);
    expect(result?.samples).toBe(5);
    expect(result?.highMs).toBeLessThan(s(70));
  });

  it('keeps every sample when there are too few to call one an outlier', () => {
    expect(estimateDuration([s(60), s(600), s(61)])?.samples).toBe(3);
  });

  it('does not throw away a one second wobble when the rest are identical', () => {
    expect(estimateDuration([s(60), s(60), s(60), s(61)])?.samples).toBe(4);
  });

  it('gives the usual range of the kept runs', () => {
    const result = estimateDuration([s(50), s(60), s(70), s(80), s(90)]);
    expect(result?.lowMs).toBeGreaterThanOrEqual(s(50));
    expect(result?.lowMs).toBeLessThan(result?.ms ?? 0);
    expect(result?.highMs).toBeGreaterThan(result?.ms ?? 0);
    expect(result?.highMs).toBeLessThanOrEqual(s(90));
  });

  it('is confident about many steady runs', () => {
    expect(estimateDuration([s(100), s(101), s(99), s(100), s(102)])?.confidence).toBe('high');
  });

  it('is unsure about two runs, however close', () => {
    expect(estimateDuration([s(100), s(100)])?.confidence).toBe('low');
  });

  it('is unsure about runs that swing widely', () => {
    expect(estimateDuration([s(30), s(100), s(60), s(150), s(90)])?.confidence).toBe('low');
  });

  it('sits in between for a handful of fairly steady runs', () => {
    expect(estimateDuration([s(100), s(120), s(90), s(110)])?.confidence).toBe('medium');
  });

  it('ignores samples that make no sense', () => {
    expect(estimateDuration([Number.NaN, -5, s(30)])?.samples).toBe(1);
  });

  it('copes with steps that always finish within the same second', () => {
    expect(estimateDuration([0, 0, 0, 0, 0])).toMatchObject({ ms: 0, confidence: 'high' });
  });
});

describe('stepKeys', () => {
  it('names each step, numbering the repeats of a name', () => {
    expect(
      stepKeys([
        { name: 'Checkout' },
        { name: 'Build' },
        { name: 'Checkout' },
        { name: 'Checkout' },
      ]),
    ).toEqual(['Checkout', 'Build', 'Checkout#2', 'Checkout#3']);
  });
});

describe('buildRunEstimates', () => {
  const run = (seconds: number, conclusion: 'success' | 'failure' = 'success') => ({
    conclusion,
    createdAt: at(0),
    updatedAt: at(seconds),
  });

  it('counts only runs that passed', () => {
    const result = buildRunEstimates([
      { run: run(30, 'failure'), jobs: [] },
      { run: run(100), jobs: [] },
      { run: run(100), jobs: [] },
    ]);
    expect(result.runs).toBe(2);
    expect(result.run?.ms).toBe(s(100));
  });

  it('estimates each job by its name', () => {
    const result = buildRunEstimates([
      { run: run(100), jobs: [job({ name: 'build', completedAt: at(40) })] },
      { run: run(100), jobs: [job({ name: 'build', completedAt: at(40) }), job({ name: 'lint' })] },
    ]);
    expect(result.jobs.build?.estimate.ms).toBe(s(40));
    expect(result.jobs.build?.estimate.samples).toBe(2);
    expect(result.jobs.lint?.estimate.samples).toBe(1);
  });

  it('leaves out jobs that failed or were skipped, even in a passing run', () => {
    const result = buildRunEstimates([
      {
        run: run(100),
        jobs: [
          job({ name: 'deploy', conclusion: 'skipped', startedAt: null, completedAt: null }),
          job({ name: 'flaky', conclusion: 'failure' }),
        ],
      },
    ]);
    expect(result.jobs).toEqual({});
  });

  it('estimates each step, telling repeated names apart', () => {
    const steps = [
      step({ number: 1, name: 'Checkout', startedAt: at(0), completedAt: at(2) }),
      step({ number: 2, name: 'Test', startedAt: at(2), completedAt: at(50) }),
      step({ number: 3, name: 'Checkout', startedAt: at(50), completedAt: at(55) }),
      step({
        number: 4,
        name: 'Deploy',
        conclusion: 'skipped',
        startedAt: null,
        completedAt: null,
      }),
    ];
    const result = buildRunEstimates([{ run: run(60), jobs: [job({ name: 'ci', steps })] }]);
    const ci = result.jobs.ci;
    expect(ci?.steps.Checkout?.ms).toBe(s(2));
    expect(ci?.steps.Test?.ms).toBe(s(48));
    expect(ci?.steps['Checkout#2']?.ms).toBe(s(5));
    expect(ci?.steps.Deploy).toBeUndefined();
  });

  it('skips a run whose times make no sense', () => {
    const result = buildRunEstimates([
      { run: { conclusion: 'success' as const, createdAt: at(10), updatedAt: at(0) }, jobs: [] },
    ]);
    expect(result.run).toBeNull();
  });
});

describe('liveEta', () => {
  it('counts down what is left and how far along it is', () => {
    expect(liveEta(s(30), s(90), s(120))).toEqual({
      remainingMs: s(90),
      overByMs: 0,
      fraction: 0.25,
    });
  });

  it('never claims a running item is done', () => {
    expect(liveEta(s(119.9), s(0.1), s(120)).fraction).toBe(0.99);
  });

  it('reports a run that went past the usual time as over, not as 0s left', () => {
    expect(liveEta(s(150), 0, s(120))).toEqual({ remainingMs: 0, overByMs: s(30), fraction: 0.99 });
  });

  it('is not over when its steps are done early but the job has not closed yet', () => {
    expect(liveEta(s(100), 0, s(120))).toEqual({ remainingMs: 0, overByMs: 0, fraction: 0.99 });
  });

  it('starts at the beginning of the bar', () => {
    expect(liveEta(0, s(60), s(60)).fraction).toBe(0);
  });
});

describe('jobRemainingMs', () => {
  const usual = {
    estimate: estimate(s(100)),
    steps: { Checkout: estimate(s(10)), Test: estimate(s(60)), Upload: estimate(s(20)) },
  };
  const NOW = T0 + s(40);

  it('is the whole usual time for a job that has not started', () => {
    const queued = job({ name: 'ci', status: 'queued', startedAt: null, completedAt: null });
    expect(jobRemainingMs(queued, usual, NOW)).toBe(s(100));
  });

  it('adds what is left of the running step to the steps still to come', () => {
    const running = job({
      name: 'ci',
      status: 'in_progress',
      conclusion: null,
      completedAt: null,
      steps: [
        step({ number: 1, name: 'Checkout', startedAt: at(0), completedAt: at(10) }),
        step({
          number: 2,
          name: 'Test',
          status: 'in_progress',
          conclusion: null,
          startedAt: at(10),
          completedAt: null,
        }),
        step({
          number: 3,
          name: 'Upload',
          status: 'queued',
          conclusion: null,
          startedAt: null,
          completedAt: null,
        }),
      ],
    });
    // Test has run 30s of its usual 60s, then Upload's 20s.
    expect(jobRemainingMs(running, usual, NOW)).toBe(s(50));
  });

  it('falls back to the job as a whole when none of its steps are known', () => {
    const running = job({
      name: 'ci',
      status: 'in_progress',
      conclusion: null,
      completedAt: null,
      steps: [
        step({ name: 'Something new', status: 'in_progress', conclusion: null, completedAt: null }),
      ],
    });
    expect(jobRemainingMs(running, usual, NOW)).toBe(s(60));
  });

  it('passes over finished steps and steps it has never seen', () => {
    const running = job({
      name: 'ci',
      status: 'in_progress',
      conclusion: null,
      completedAt: null,
      steps: [
        step({ number: 1, name: 'Checkout', startedAt: at(0), completedAt: at(10) }),
        step({
          number: 2,
          name: 'Brand new step',
          status: 'in_progress',
          conclusion: null,
          startedAt: at(10),
          completedAt: null,
        }),
        step({
          number: 3,
          name: 'Upload',
          status: 'queued',
          conclusion: null,
          startedAt: null,
          completedAt: null,
        }),
      ],
    });
    expect(jobRemainingMs(running, usual, NOW)).toBe(s(20));
  });

  it('treats a start time it cannot read as just started', () => {
    const running = job({
      name: 'ci',
      status: 'in_progress',
      conclusion: null,
      startedAt: 'not a date',
      completedAt: null,
    });
    expect(jobRemainingMs(running, usual, NOW)).toBe(s(100));
  });

  it('is nothing for a job that has finished', () => {
    expect(jobRemainingMs(job({ name: 'ci' }), usual, NOW)).toBe(0);
  });
});

describe('runRemainingMs', () => {
  it('waits for the slowest job, since jobs run side by side', () => {
    expect(runRemainingMs(s(100), s(30), [s(20), s(90)])).toBe(s(90));
  });

  it('goes by the usual run when that is further off', () => {
    expect(runRemainingMs(s(100), s(30), [s(20)])).toBe(s(70));
  });

  it('never goes below nothing', () => {
    expect(runRemainingMs(s(100), s(130), [])).toBe(0);
  });
});

describe('compareToUsual', () => {
  it('calls out a run that was clearly slower', () => {
    expect(compareToUsual(s(150), estimate(s(100)))).toEqual({ kind: 'slower', deltaMs: s(50) });
  });

  it('calls out a run that was clearly faster', () => {
    expect(compareToUsual(s(70), estimate(s(100)))).toEqual({ kind: 'faster', deltaMs: s(30) });
  });

  it('keeps quiet about small differences', () => {
    expect(compareToUsual(s(110), estimate(s(100))).kind).toBe('usual');
  });

  it('keeps quiet about a few seconds on a short step, however large in percent', () => {
    expect(compareToUsual(s(6), estimate(s(3))).kind).toBe('usual');
  });
});
