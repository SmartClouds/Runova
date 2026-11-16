import { randomUUID } from 'node:crypto';
import { findSavedServer } from '../../ssh/savedServers';
import { getSshPool } from '../../ssh/sharedPool';
import { isE2E } from '../../testMode';
import { withToolPath } from '../../toolPaths';
import { fetchRegisteredRunners } from './github';
import { createMachineShell, runLocalScript } from './machineShell';
import { createRunnerCleanupService, type RunnerCleanupService } from './service';

/** The runner cleanup wired to the real SSH pool, this computer's shell and gh (E104). */
export function createRealRunnerCleanup(): RunnerCleanupService {
  const shell = createMachineShell({
    platform: process.platform,
    isE2E,
    findServer: findSavedServer,
    acquire: (serverId) => getSshPool().acquire(serverId),
    runLocal: async (input) => runLocalScript(input, await withToolPath(process.env)),
  });
  return createRunnerCleanupService({
    shell,
    registeredRunners: fetchRegisteredRunners,
    now: Date.now,
    newId: randomUUID,
  });
}
