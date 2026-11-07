import {
  type CodeqlInstallProgress,
  type DevInstallPhase,
  getAgentToolDefinition,
} from '@runova/core';
import type { ManagedRunners } from './managedDispatch';
import type { RunHooks, RunResult } from './packageManagerRunner';

/**
 * What Dev Setup's Security stack sets up itself: CodeQL's release, the SonarQube server container
 * and the Bearer image. Each one reuses what the Dev Tools card and the Security tab already do, so
 * the three places cannot drift apart. The machine (Docker, the CodeQL download) is injected.
 */

export interface SecurityToolsDeps {
  /** Runs one command with a package manager's patience, progress and log. */
  runArgv: (argv: readonly string[], hooks: RunHooks) => Promise<RunResult>;
  /** Whether a container by this name exists, running or stopped. */
  containerExists: (name: string) => Promise<boolean>;
  /** Downloads, checks and unpacks CodeQL. Resolves when done or cancelled, throws on failure. */
  installCodeql: (onProgress: (progress: CodeqlInstallProgress) => void) => Promise<void>;
  cancelCodeql: () => void;
}

const CANCELLED: RunResult = { ok: false, code: null, cancelled: true };
const OK: RunResult = { ok: true, code: 0, cancelled: false };
const fail = (message: string): RunResult => ({ ok: false, code: null, cancelled: false, message });

/** The CodeQL card's phases in Dev Setup's words. Ends (done, failed) are left to the result. */
function phaseOf(phase: CodeqlInstallProgress['phase']): DevInstallPhase | null {
  switch (phase) {
    case 'resolving':
      return 'preparing';
    case 'downloading':
      return 'downloading';
    case 'verifying':
      return 'verifying';
    case 'extracting':
      return 'extracting';
    default:
      return null;
  }
}

export function createSecurityTools(deps: SecurityToolsDeps): ManagedRunners['security'] {
  return {
    async downloadCodeql(hooks) {
      if (hooks.token.cancelled) return CANCELLED;
      hooks.onCancel?.(deps.cancelCodeql);
      try {
        await deps.installCodeql((progress) => {
          const phase = phaseOf(progress.phase);
          if (phase)
            hooks.onProgress({ phase, fraction: progress.fraction, detail: progress.message });
        });
      } catch (error) {
        if (hooks.token.cancelled) return CANCELLED;
        return fail(error instanceof Error ? error.message : String(error));
      }
      // A cancelled install resolves rather than throws, so the token is what tells the two apart.
      return hooks.token.cancelled ? CANCELLED : OK;
    },

    async startContainer(toolId, hooks) {
      const docker = getAgentToolDefinition(toolId)?.docker;
      if (!docker) return fail('That tool has no container to start.');
      if (hooks.token.cancelled) return CANCELLED;
      const name = docker.containerName;
      // Starting the one that is there keeps its data and its admin password. Creating it again
      // would fail on the name, and resetting it is the Dev Tools card's job, not a checklist's.
      if (await deps.containerExists(name)) {
        hooks.onProgress({ phase: 'installing', fraction: null, detail: `Starting ${name}` });
        return deps.runArgv(['docker', 'start', name], hooks);
      }
      hooks.onProgress({ phase: 'downloading', fraction: null, detail: `Creating ${name}` });
      return deps.runArgv(
        [
          'docker',
          'run',
          '-d',
          '--name',
          name,
          ...docker.runArgs,
          docker.image,
          ...(docker.imageArgs ?? []),
        ],
        hooks,
      );
    },

    async pullImage(image, hooks) {
      if (hooks.token.cancelled) return CANCELLED;
      hooks.onProgress({ phase: 'downloading', fraction: null, detail: `Pulling ${image}` });
      return deps.runArgv(['docker', 'pull', image], hooks);
    },
  };
}
