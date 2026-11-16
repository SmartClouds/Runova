import os from 'node:os';
import type {
  InstallRunnerInput,
  SshAgentProgress,
  StartSshAgentTaskInput,
} from '../../shared/apiTypes';
import { validateRunnerName } from '../../shared/runnerName';
import { isShellSessionReady, type ShellTaskExtras, startSshTask } from '../agents/sshTaskRunner';
import {
  fetchRegistrationToken,
  latestRunnerVersion,
  localRunnerDefaults,
  RUNNER_TOKEN_PLACEHOLDER,
  runnerInstallGuide,
  runnerInstallTask,
} from './runnerInstall';

/** A tab opened a moment ago is usually live within a second; an SSH login can take longer. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface RunnerInstallDeps {
  isReady: (sessionId: string, target: 'ssh' | 'local') => boolean;
  fetchToken: (repo: string) => Promise<string>;
  latestVersion: () => Promise<string | null>;
  start: (
    input: StartSshAgentTaskInput,
    listener: (progress: SshAgentProgress) => void,
    extras: ShellTaskExtras,
  ) => void;
  machine: () => { platform: string; arch: string; homeDir: string };
  wait: (ms: number) => Promise<void>;
  now: () => number;
}

const realDeps: RunnerInstallDeps = {
  isReady: isShellSessionReady,
  fetchToken: fetchRegistrationToken,
  latestVersion: latestRunnerVersion,
  start: startSshTask,
  machine: () => {
    const { platform, arch } = localRunnerDefaults();
    return { platform, arch, homeDir: os.homedir() };
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Checks the request, gets a registration token and the newest runner version, waits for the tab
 * to be live and hands the install to the terminal AI. The token goes in as a secret, so the AI
 * only ever sees its placeholder.
 */
export async function startRunnerInstall(
  input: InstallRunnerInput,
  listener: (progress: SshAgentProgress) => void,
  deps: RunnerInstallDeps = realDeps,
): Promise<void> {
  const { sessionId, target, repo } = input;
  if (target !== 'local' && target !== 'ssh') {
    throw new Error('A runner goes on this computer or a saved server.');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const nameProblem = validateRunnerName(name, []);
  if (nameProblem) throw new Error(nameProblem);
  if (typeof repo !== 'string' || !REPO.test(repo)) {
    throw new Error('The repository has to be written as owner/name.');
  }

  const [token, version] = await Promise.all([deps.fetchToken(repo), deps.latestVersion()]);

  const deadline = deps.now() + READY_TIMEOUT_MS;
  while (!deps.isReady(sessionId, target)) {
    if (deps.now() >= deadline) {
      throw new Error(
        target === 'ssh'
          ? 'The SSH session did not connect in time. Check the server in Remote and try again.'
          : 'The terminal did not start in time. Try again.',
      );
    }
    await deps.wait(READY_POLL_MS);
  }

  deps.start(
    {
      sessionId,
      target,
      prompt: runnerInstallTask(name, repo),
      mode: input.mode,
      cliId: input.cliId ?? null,
      modelId: input.modelId ?? null,
      effort: input.effort ?? null,
    },
    listener,
    {
      secrets: { [RUNNER_TOKEN_PLACEHOLDER]: token },
      guide: runnerInstallGuide({
        name,
        repo,
        version,
        machine: target === 'local' ? { kind: 'local', ...deps.machine() } : { kind: 'ssh' },
      }),
    },
  );
}
