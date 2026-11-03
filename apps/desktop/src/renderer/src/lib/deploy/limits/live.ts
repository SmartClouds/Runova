import { limitCpus, type ServiceLimits } from '@runova/core';
import type { LimitsHostFacts } from './editor';

/**
 * Live caps on a container no app owns go through docker update, which knows only cores of CPU
 * time and bytes. These turn them into the editor's cores and share and back. Docker cannot drop
 * a cap once set, so "no cap" is sent as the whole server, and read back as no cap.
 */

const MB = 1024 * 1024;

export function liveLimitsOf(
  service: string,
  details: { cpuLimit?: number | null; memoryLimitBytes?: number | null },
  host: LimitsHostFacts,
): ServiceLimits {
  const limit: ServiceLimits = { service };
  const cpus = details.cpuLimit;
  if (typeof cpus === 'number' && cpus > 0 && cpus < host.cores) {
    const cores = Math.min(host.cores, Math.max(1, Math.ceil(cpus)));
    limit.cpuCores = cores;
    limit.cpuPercent = Math.min(100, Math.max(5, Math.round((cpus / cores) * 100)));
  }
  const bytes = details.memoryLimitBytes;
  if (typeof bytes === 'number' && bytes > 0 && bytes < host.memoryMb * MB) {
    limit.memoryMb = Math.round(bytes / MB);
  }
  return limit;
}

/** What setLimits sends: the first (only) service's caps, null where there is none. */
export function liveRequestOf(limits: readonly ServiceLimits[]): {
  cpus: number | null;
  memoryMb: number | null;
} {
  const [limit] = limits;
  return {
    cpus: limit ? limitCpus(limit) : null,
    memoryMb: typeof limit?.memoryMb === 'number' ? limit.memoryMb : null,
  };
}
