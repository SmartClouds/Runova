import { type DependencyAlertsSummary, EMPTY_DEPENDENCY_SUMMARY } from '@shared/dependencyAlerts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/**
 * What the server's daily checks found in each project (E51), as main last heard it. Main pushes
 * every change (a check ran, a setting or a mute changed), so the badges never poll.
 */
export function useDependencyAlerts(): DependencyAlertsSummary {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.dependencyAlerts,
    queryFn: async () =>
      (await window.runova.dependencyAlerts.summary()) ?? EMPTY_DEPENDENCY_SUMMARY,
    meta: { silentLoading: true },
  });

  useEffect(
    () =>
      window.runova.dependencyAlerts.onChanged((summary) => {
        queryClient.setQueryData(queryKeys.dependencyAlerts, summary);
      }),
    [queryClient],
  );

  return query.data ?? EMPTY_DEPENDENCY_SUMMARY;
}

/** "1 project with package updates", for a badge's screen reader text. */
export function projectsWithUpdatesLabel(count: number): string {
  return `${count} project${count === 1 ? '' : 's'} with package updates`;
}
