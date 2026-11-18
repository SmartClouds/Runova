import type {
  GithubRunEstimatesInput,
  GithubRunEstimatesResult,
  GithubWorkflowRunInfo,
} from '../../shared/apiTypes';
import { buildRunEstimates, type EstimateHistoryEntry } from '../../shared/pipelineEstimates';
import { ghErrorMessage } from '../git/githubCli';
import { fetchRunDetails, listWorkflowRuns, parseOwnerRepo } from './githubActions';

/** Passing runs asked for, so a few left out (the one being looked at) still leave enough. */
const LIST_SIZE = 15;
/** Passing runs read for their jobs. Older ones say less about how the pipeline runs today. */
const SAMPLE_RUNS = 8;
/** Runs read at the same time, so one estimate does not crowd out every other gh call. */
const CONCURRENCY = 3;
/**
 * Only finished runs go into an estimate, so it holds for a whole live run. Ten minutes also picks
 * up a run that passed in the meantime soon enough.
 */
const CACHE_MS = 10 * 60_000;
const CACHE_CAP = 100;

const cache = new Map<string, { result: GithubRunEstimatesResult & { ok: true }; at: number }>();

/** Forgets every kept estimate. For tests. */
export function clearRunEstimatesCache(): void {
  cache.clear();
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order of the answers. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * How long a pipeline's runs, jobs and steps usually take, from its latest passing runs. Each run's
 * jobs are read through `fetchRunDetails`, so they share its cache with the details view. A run
 * whose jobs cannot be read still counts for the run as a whole.
 */
export async function fetchRunEstimates(
  input: GithubRunEstimatesInput,
): Promise<GithubRunEstimatesResult> {
  const parsed = parseOwnerRepo(String(input?.repo ?? ''));
  const workflowId = Number(input?.workflowId);
  if (!parsed || !Number.isInteger(workflowId) || workflowId <= 0) {
    return { ok: false, error: 'That pipeline could not be identified.' };
  }
  const exclude = Number(input.excludeRunId) || 0;
  const key = `${parsed.owner}/${parsed.repo}#${workflowId}-${exclude}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;

  let runs: GithubWorkflowRunInfo[];
  try {
    runs = await listWorkflowRuns(parsed.owner, parsed.repo, workflowId, LIST_SIZE, 'success');
  } catch (error) {
    return { ok: false, error: ghErrorMessage(error) };
  }

  const sample = runs.filter((run) => run.id !== exclude).slice(0, SAMPLE_RUNS);
  const history = await mapLimited(
    sample,
    CONCURRENCY,
    async (run): Promise<EstimateHistoryEntry> => {
      const details = await fetchRunDetails({
        repo: `${parsed.owner}/${parsed.repo}`,
        runId: run.id,
        attempt: run.runAttempt,
      });
      return { run, jobs: details.ok ? details.jobs : [] };
    },
  );

  const result = { ok: true as const, estimates: buildRunEstimates(history) };
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { result, at: Date.now() });
  return result;
}
