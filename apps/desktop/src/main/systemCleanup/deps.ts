import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DevOs } from '@runova/core';
import { app } from 'electron';
import { store } from '../store';
import { isE2E } from '../testMode';
import { createDeletionLog } from './deletionLog';
import { protectedFolders } from './protectedFolders';
import { createSystemCleanup, type SystemCleanupService } from './runtime';
import { cleanupAvailability } from './sandbox';
import { createToolRunner, findTools } from './tools';

/**
 * Disk Cleanup wired to the real app: Electron's folders, the project store, the tools on this
 * machine and a log in the app's own data folder. Under the end-to-end harness it only works inside
 * the sandbox folder the test names (see `sandbox.ts`).
 */

function currentOs(): DevOs {
  if (process.platform === 'win32') return 'win32';
  return process.platform === 'darwin' ? 'darwin' : 'linux';
}

export function createRealSystemCleanup(): SystemCleanupService {
  const os = currentOs();
  const log = createDeletionLog(join(app.getPath('userData'), 'logs', 'disk-cleanup.log'));
  const availability = () =>
    cleanupAvailability({
      isE2E,
      folder: process.env.RUNOVA_CLEANUP_SANDBOX,
      baseEnv: process.env,
      os,
    });

  return createSystemCleanup({
    availability,
    os,
    baseEnv: () => process.env,
    homeDir: () => homedir(),
    // A test sandbox sits in the temp folder, which is protected on a real machine. Inside a
    // sandbox the stricter rule applies instead: nothing outside the sandbox is touched at all.
    protectedFolders: () =>
      availability().sandbox
        ? []
        : protectedFolders({
            os,
            env: process.env,
            getPath: (name) => app.getPath(name as 'home'),
          }),
    projectFolders: async () =>
      (await store.getProjects()).map((project) => project.folderPath).filter(Boolean),
    findTools,
    makeRunner: (home, env) => createToolRunner({ home, baseEnv: env }),
    newId: randomUUID,
    now: Date.now,
    log: (entry) => log.append(entry),
  });
}
