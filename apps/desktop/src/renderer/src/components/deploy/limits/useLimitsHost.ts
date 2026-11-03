import { useQuery } from '@tanstack/react-query';
import { limitsHostOf } from '@/lib/deploy/limits/host';
import { queryKeys } from '@/lib/queryKeys';

/** The server's size for the limits editor, from the Docker status the Containers screen reads too. */
export function useLimitsHost(serverId: string, enabled = true) {
  const status = useQuery({
    queryKey: queryKeys.deployDockerStatus(serverId),
    queryFn: () => window.runova.deployDocker.status(serverId),
    enabled,
    retry: false,
  });
  return {
    host: limitsHostOf(status.data),
    loading: status.isLoading,
    /** The core answered but does not report the facts: it is too old to apply caps. */
    outdated: status.data !== undefined && limitsHostOf(status.data) === null,
  };
}
