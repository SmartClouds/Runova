import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubRunDetailsInput,
  GithubRunDetailsResult,
  GithubRunJob,
  GithubWorkflowRunInfo,
} from '../../shared/apiTypes';

/**
 * The estimates are built from two reads that already have their own tests in githubActions: the
 * workflow's latest passing runs, and each run's jobs. Those two are stubbed here, so this covers
 * which runs get read, how many at once, what is left out and what is kept for later.
 */

const gh = vi.hoisted(() => ({
  runs: [] as GithubWorkflowRunInfo[],
  listCalls: [] as unknown[][],
  listError: null as Error | null,
  details: new Map<number, GithubRunDetailsResult>(),
  detailCalls: [] as GithubRunDetailsInput[],
  inFlight: 0,
  maxInFlight: 0,
}));

vi.mock('./githubActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./githubActions')>();
  return {
    parseOwnerRepo: actual.parseOwnerRepo,
    listWorkflowRuns: async (...args: unknown[]) => {
      gh.listCalls.push(args);
      if (gh.listError) throw gh.listError;
      return gh.runs;
    },
    fetchRunDetails: async (input: GithubRunDetailsInput) => {
      gh.detailCalls.push(input);
      gh.inFlight++;
      gh.maxInFlight = Math.max(gh.maxInFlight, gh.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      gh.inFlight--;
      return gh.details.get(input.runId) ?? { ok: false, error: 'not found' };
    },
  };
});

const { fetchRunEstimates, clearRunEstimatesCache } = await import('./runEstimates');

const T0 = Date.parse('2026-11-18T10:00:00Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function run(id: number, seconds = 120): GithubWorkflowRunInfo {
  return {
    id,
    workflowId: 77,
    name: 'CI',
    displayTitle: 'Fix it',
    runNumber: id,
    headBranch: 'main',
    status: 'completed',
    conclusion: 'success',
    htmlUrl: '',
    createdAt: at(0),
    updatedAt: at(seconds),
    runAttempt: 1,
  };
}

function job(name: string, seconds: number): GithubRunJob {
  return {
    id: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    startedAt: at(0),
    completedAt: at(seconds),
    htmlUrl: null,
    runnerName: null,
    steps: [],
  };
}

beforeEach(() => {
  clearRunEstimatesCache();
  gh.runs = [];
  gh.listCalls = [];
  gh.listError = null;
  gh.details = new Map();
  gh.detailCalls = [];
  gh.inFlight = 0;
  gh.maxInFlight = 0;
});

describe('fetchRunEstimates', () => {
  it("works the estimates out from the workflow's latest passing runs", async () => {
    gh.runs = [run(3, 100), run(2, 100), run(1, 100)];
    for (const id of [1, 2, 3]) gh.details.set(id, { ok: true, jobs: [job('build', 60)] });

    const result = await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });

    expect(gh.listCalls).toEqual([['acme', 'demo', 77, 15, 'success']]);
    expect(result.ok && result.estimates.runs).toBe(3);
    expect(result.ok && result.estimates.run?.ms).toBe(100_000);
    expect(result.ok && result.estimates.jobs.build?.estimate.ms).toBe(60_000);
  });

  it('reads each run at the attempt that passed', async () => {
    gh.runs = [{ ...run(5), runAttempt: 2 }];
    gh.details.set(5, { ok: true, jobs: [] });

    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });

    expect(gh.detailCalls).toEqual([{ repo: 'acme/demo', runId: 5, attempt: 2 }]);
  });

  it('leaves out the run being looked at, and reads no more than eight', async () => {
    gh.runs = Array.from({ length: 12 }, (_, index) => run(100 - index));

    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77, excludeRunId: 99 });

    const read = gh.detailCalls.map((call) => call.runId).sort((a, b) => b - a);
    expect(read).toEqual([100, 98, 97, 96, 95, 94, 93, 92]);
  });

  it('reads at most three runs at a time', async () => {
    gh.runs = Array.from({ length: 8 }, (_, index) => run(index + 1));

    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });

    expect(gh.detailCalls).toHaveLength(8);
    expect(gh.maxInFlight).toBe(3);
  });

  it('still counts a run whose jobs could not be read, for the run as a whole', async () => {
    gh.runs = [run(2, 100), run(1, 100)];
    gh.details.set(2, { ok: true, jobs: [job('build', 60)] });

    const result = await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });

    expect(result.ok && result.estimates.run?.samples).toBe(2);
    expect(result.ok && result.estimates.jobs.build?.estimate.samples).toBe(1);
  });

  it('keeps the answer for a while instead of asking GitHub again', async () => {
    gh.runs = [run(1)];
    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77, excludeRunId: 5 });
    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77, excludeRunId: 5 });

    expect(gh.listCalls).toHaveLength(1);
  });

  it('asks again once the kept answer is too old', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    try {
      gh.runs = [run(1)];
      await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });
      vi.setSystemTime(T0 + 11 * 60_000);
      await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });
      expect(gh.listCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a separate answer for each workflow and each run being looked at', async () => {
    gh.runs = [run(1)];
    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77, excludeRunId: 5 });
    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 78, excludeRunId: 5 });
    await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77, excludeRunId: 6 });

    expect(gh.listCalls).toHaveLength(3);
  });

  it('turns down a repo it cannot read', async () => {
    await expect(fetchRunEstimates({ repo: 'not a repo', workflowId: 77 })).resolves.toEqual({
      ok: false,
      error: 'That pipeline could not be identified.',
    });
    await expect(fetchRunEstimates({ repo: 'acme/demo', workflowId: 0 })).resolves.toMatchObject({
      ok: false,
    });
    expect(gh.listCalls).toEqual([]);
  });

  it('says why when GitHub cannot list the runs, and does not keep that', async () => {
    gh.listError = Object.assign(new Error('Command failed'), { stderr: 'HTTP 404: Not Found' });

    const first = await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });
    gh.listError = null;
    const second = await fetchRunEstimates({ repo: 'acme/demo', workflowId: 77 });

    expect(first).toEqual({ ok: false, error: 'HTTP 404: Not Found' });
    expect(second.ok).toBe(true);
  });
});
