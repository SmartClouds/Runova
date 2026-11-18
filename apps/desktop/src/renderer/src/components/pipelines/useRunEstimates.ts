import type { RunEstimates } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';

/** Estimates come from finished runs only, so they hold for a good while. */
const ESTIMATES_STALE_MS = 10 * 60_000;

/**
 * How long a pipeline's runs, jobs and steps usually take, leaving out the run on screen. When
 * GitHub cannot say, the query errors and the views just go without estimates.
 */
export function useRunEstimates(
  repo: string,
  workflowId: number,
  excludeRunId: number | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.runEstimates(repo, workflowId, excludeRunId ?? 0),
    queryFn: async (): Promise<RunEstimates> => {
      const result = await window.runova.pipelines.runEstimates({
        repo,
        workflowId,
        excludeRunId,
      });
      if (!result.ok) throw new Error(result.error);
      return result.estimates;
    },
    enabled: enabled && workflowId > 0 && repo !== '',
    staleTime: ESTIMATES_STALE_MS,
    retry: false,
    meta: { silentLoading: true },
  });
}
