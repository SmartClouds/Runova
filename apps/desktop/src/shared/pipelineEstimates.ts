import type {
  DurationEstimate,
  EstimateConfidence,
  GithubRunJob,
  GithubWorkflowRunInfo,
  JobEstimate,
  RunEstimates,
} from './apiTypes';

/**
 * Estimates for how long a pipeline's runs, jobs and steps take, worked out from its earlier
 * passing runs.
 *
 * Every list of samples here is newest first. Each sample counts half as much as one three runs
 * newer, so a pipeline that got slower (or faster) as its code grew is followed within a few runs.
 * The estimate is a weighted median rather than a mean, so one slow run cannot drag it, and runs
 * far from the rest (a hung job, a cold cache) are left out before it is taken.
 */

/** Each sample counts half as much as one this many runs newer. */
const HALF_LIFE_RUNS = 3;
/** How many scaled MADs from the centre a sample can be before it counts as an outlier. */
const OUTLIER_MADS = 3;
/** Scales the MAD to a standard deviation's size for normally spread samples. */
const MAD_SCALE = 1.4826;
/** Below this many samples, none of them can be told apart as an outlier. */
const MIN_FOR_OUTLIERS = 4;
/** Never call a sample an outlier for being this close, since GitHub times are whole seconds. */
const OUTLIER_FLOOR_MS = 1000;
const OUTLIER_FLOOR_SHARE = 0.1;
/** The usual range runs from this weighted percentile to its mirror. */
const RANGE_PERCENTILE = 0.2;
/** A running bar stops short of full, since nothing has said the item is done yet. */
const LIVE_CAP = 0.99;
/** A finished item is only called faster or slower when it is off by this share and this much. */
const NOTABLE_SHARE = 0.15;
const NOTABLE_MS = 5000;

interface Weighted {
  value: number;
  weight: number;
}

/** The first value whose running weight reaches `share` of the total. `samples` is never empty. */
function weightedPercentile(samples: Weighted[], share: number): number {
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let running = 0;
  for (let index = 0; index < sorted.length - 1; index++) {
    const item = sorted[index] as Weighted;
    running += item.weight;
    if (running >= share * total - 1e-9) return item.value;
  }
  return (sorted[sorted.length - 1] as Weighted).value;
}

/** The weighted median distance of the samples from `centre`. */
function weightedMad(samples: Weighted[], centre: number): number {
  return weightedPercentile(
    samples.map((item) => ({ value: Math.abs(item.value - centre), weight: item.weight })),
    0.5,
  );
}

function confidenceOf(samples: Weighted[], centre: number): EstimateConfidence {
  const spread = centre > 0 ? (MAD_SCALE * weightedMad(samples, centre)) / centre : 0;
  if (samples.length <= 2 || spread > 0.4) return 'low';
  if (samples.length >= 5 && spread <= 0.15) return 'high';
  return 'medium';
}

/** What the samples (in ms, newest first) say an item usually takes, or null without any. */
export function estimateDuration(samplesMs: number[]): DurationEstimate | null {
  let samples: Weighted[] = samplesMs
    .map((value, age) => ({ value, weight: 0.5 ** (age / HALF_LIFE_RUNS) }))
    .filter((item) => Number.isFinite(item.value) && item.value >= 0);
  if (samples.length === 0) return null;

  if (samples.length >= MIN_FOR_OUTLIERS) {
    // Measured from the weighted centre, so after a lasting change it is the old runs that go.
    const centre = weightedPercentile(samples, 0.5);
    const limit = Math.max(
      OUTLIER_MADS * MAD_SCALE * weightedMad(samples, centre),
      OUTLIER_FLOOR_SHARE * centre,
      OUTLIER_FLOOR_MS,
    );
    samples = samples.filter((item) => Math.abs(item.value - centre) <= limit);
  }

  const ms = weightedPercentile(samples, 0.5);
  return {
    ms,
    lowMs: weightedPercentile(samples, RANGE_PERCENTILE),
    highMs: weightedPercentile(samples, 1 - RANGE_PERCENTILE),
    samples: samples.length,
    confidence: confidenceOf(samples, ms),
  };
}

/** How long between two ISO times, or null when either is missing or they make no sense. */
export function spanMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * What each step is known by across runs. GitHub's step ids are new on every run, so a step goes by
 * its name, and the second and later steps of the same name in a job get `#2`, `#3`.
 */
export function stepKeys(steps: { name: string }[]): string[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const count = (seen.get(step.name) ?? 0) + 1;
    seen.set(step.name, count);
    return count === 1 ? step.name : `${step.name}#${count}`;
  });
}

function push(map: Map<string, number[]>, key: string, value: number | null): void {
  if (value === null) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * When a run's work began: the earliest start among its jobs that have really started. GitHub fills
 * in `started_at` on a job that is still queued too, so the status decides, not the field. A
 * skipped job never ran. Null while no job has started, e.g. when every runner is busy.
 */
export function workStartedAt(
  jobs: Pick<GithubRunJob, 'status' | 'conclusion' | 'startedAt'>[] | undefined,
): string | null {
  let earliest: string | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const job of jobs ?? []) {
    if (job.status !== 'in_progress' && job.status !== 'completed') continue;
    if (job.conclusion === 'skipped' || !job.startedAt) continue;
    const ms = Date.parse(job.startedAt);
    if (Number.isFinite(ms) && ms < earliestMs) {
      earliest = job.startedAt;
      earliestMs = ms;
    }
  }
  return earliest;
}

export interface EstimateHistoryEntry {
  run: Pick<GithubWorkflowRunInfo, 'conclusion' | 'createdAt' | 'updatedAt'>;
  jobs: GithubRunJob[];
}

/**
 * The estimates for a pipeline from its earlier runs, newest first. Only passing runs, jobs and
 * steps count: a failed or cancelled one stopped early and would make the usual time look shorter.
 * Jobs go by name, since GitHub's job ids are new on every run; a matrix job's name carries its
 * matrix values, so each leg gets its own estimate.
 */
export function buildRunEstimates(history: EstimateHistoryEntry[]): RunEstimates {
  const passed = history.filter((entry) => entry.run.conclusion === 'success');
  const runSamples: number[] = [];
  const jobSamples = new Map<string, number[]>();
  const stepSamples = new Map<string, Map<string, number[]>>();

  for (const entry of passed) {
    // From the first job's start, so time spent waiting for a runner is not part of the usual time.
    const runMs = spanMs(workStartedAt(entry.jobs) ?? entry.run.createdAt, entry.run.updatedAt);
    if (runMs !== null) runSamples.push(runMs);
    for (const job of entry.jobs) {
      if (job.conclusion !== 'success') continue;
      push(jobSamples, job.name, spanMs(job.startedAt, job.completedAt));
      const steps = stepSamples.get(job.name) ?? new Map<string, number[]>();
      stepSamples.set(job.name, steps);
      const keys = stepKeys(job.steps);
      job.steps.forEach((step, index) => {
        if (step.conclusion !== 'success') return;
        push(steps, keys[index] as string, spanMs(step.startedAt, step.completedAt));
      });
    }
  }

  const jobs: Record<string, JobEstimate> = {};
  for (const [name, samples] of jobSamples) {
    const estimate = estimateDuration(samples);
    if (!estimate) continue;
    const steps: Record<string, DurationEstimate> = {};
    for (const [key, stepMs] of stepSamples.get(name) ?? []) {
      const stepEstimate = estimateDuration(stepMs);
      if (stepEstimate) steps[key] = stepEstimate;
    }
    jobs[name] = { estimate, steps };
  }

  return { runs: passed.length, run: estimateDuration(runSamples), jobs };
}

export interface LiveEta {
  /** How much longer it should take. */
  remainingMs: number;
  /** How far past its usual time it has gone, once nothing is left. */
  overByMs: number;
  /** How far along it is, for a progress bar. Never quite 1 while it is still going. */
  fraction: number;
}

/** Where a running item stands, given how long it has run and how long it should have left. */
export function liveEta(elapsedMs: number, remainingMs: number, estimateMs: number): LiveEta {
  const remaining = Math.max(remainingMs, 0);
  const elapsed = Math.max(elapsedMs, 0);
  const total = elapsed + remaining;
  return {
    remainingMs: remaining,
    overByMs: remaining > 0 ? 0 : Math.max(elapsed - estimateMs, 0),
    fraction: remaining > 0 && total > 0 ? Math.min(elapsed / total, LIVE_CAP) : LIVE_CAP,
  };
}

function elapsedSince(start: string | null, now: number): number {
  if (!start) return 0;
  const started = Date.parse(start);
  return Number.isFinite(started) ? Math.max(now - started, 0) : 0;
}

/**
 * How much longer a job should take. A queued job has its whole usual time ahead of it. A running
 * one goes by its steps when they are known: what is left of the step under way, plus the usual
 * time of each step still to come. That follows a job whose early steps ran fast or slow better
 * than the job's own total does, which is only the fallback.
 */
export function jobRemainingMs(job: GithubRunJob, usual: JobEstimate, now: number): number {
  if (job.status === 'completed') return 0;
  if (!job.startedAt) return usual.estimate.ms;

  const keys = stepKeys(job.steps);
  const known = keys.some((key) => usual.steps[key]);
  if (!known) return Math.max(usual.estimate.ms - elapsedSince(job.startedAt, now), 0);

  let remaining = 0;
  job.steps.forEach((step, index) => {
    const estimate = usual.steps[keys[index] as string];
    if (!estimate || step.status === 'completed') return;
    remaining += step.startedAt
      ? Math.max(estimate.ms - elapsedSince(step.startedAt, now), 0)
      : estimate.ms;
  });
  return remaining;
}

/**
 * How much longer a run should take: whichever is further off, the run's usual time or its
 * slowest job. Jobs run side by side, so their times are never added up.
 */
export function runRemainingMs(
  runEstimateMs: number,
  runElapsedMs: number,
  jobsRemainingMs: number[],
): number {
  return Math.max(runEstimateMs - runElapsedMs, ...jobsRemainingMs, 0);
}

export type UsualComparison =
  | { kind: 'usual'; deltaMs: number }
  | { kind: 'faster' | 'slower'; deltaMs: number };

/**
 * How a finished item's time compares with its usual one. Only a clear difference counts (15%, and
 * at least five seconds), so the noise of an ordinary run is not called out.
 */
export function compareToUsual(actualMs: number, estimate: DurationEstimate): UsualComparison {
  const delta = actualMs - estimate.ms;
  const notable = Math.abs(delta) >= Math.max(NOTABLE_SHARE * estimate.ms, NOTABLE_MS);
  if (!notable) return { kind: 'usual', deltaMs: Math.abs(delta) };
  return { kind: delta > 0 ? 'slower' : 'faster', deltaMs: Math.abs(delta) };
}
