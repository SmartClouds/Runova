import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';

/** PLAN.md and the records of a project, refreshed when its files change (see useRelayBoard). */
export function usePlanPack(projectId: string) {
  return useQuery({
    queryKey: queryKeys.relayPlanPack(projectId),
    queryFn: () => window.runova.relay.planPack(projectId),
  });
}

/**
 * Which open workarounds can go. The check may ask the package registries, so it is kept for
 * ten minutes and only runs while a view that shows it is open.
 */
export function useRevisits(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.relayRevisits(projectId),
    queryFn: () => window.runova.relay.revisits(projectId),
    enabled,
    staleTime: 10 * 60_000,
  });
}
