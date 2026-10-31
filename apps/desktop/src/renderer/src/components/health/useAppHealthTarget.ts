import type { HealthTargetSummary } from '@shared/healthTypes';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { useHealthChanges } from './useHealth';

/**
 * The health check added for one deployed app, if there is one. A quiet read: a failure here
 * only hides the chip on the app page, Monitoring itself reports problems with checks.
 */
export function useAppHealthTarget(
  serverId: string,
  stackId: string,
): { target: HealthTargetSummary | null; isPending: boolean } {
  useHealthChanges();
  const query = useQuery({
    queryKey: queryKeys.healthList(),
    queryFn: async (): Promise<HealthTargetSummary[]> => (await window.runova.health.list()) ?? [],
    meta: { silentLoading: true },
  });
  const target =
    query.data?.find(
      (one) => one.appLink?.serverId === serverId && one.appLink.stackId === stackId,
    ) ?? null;
  return { target, isPending: query.isPending };
}
