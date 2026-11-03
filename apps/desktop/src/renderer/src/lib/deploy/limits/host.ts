import type { DockerStatus } from '../../../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { LimitsHostFacts } from './editor';

/**
 * What the limits editor needs from the server's Docker status: its cores, its memory and whether
 * it can cap a container's disk. Null when there is no status yet, or when the core is too old to
 * report them, which is also the sign that it would not apply caps: the app asks for an update.
 */
export function limitsHostOf(status: DockerStatus | undefined): LimitsHostFacts | null {
  if (!status || typeof status.cpus !== 'number' || typeof status.memoryBytes !== 'number') {
    return null;
  }
  return {
    cores: status.cpus,
    memoryMb: Math.floor(status.memoryBytes / (1024 * 1024)),
    diskLimits: status.diskLimits === true,
    diskNote: status.diskLimitNote ?? null,
  };
}
