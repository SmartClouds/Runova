import { describe, expect, it, vi } from 'vitest';
import type { InstallRunnerInput, StartSshAgentTaskInput } from '../../shared/apiTypes';

vi.mock('../agents/sshTaskRunner', () => ({
  isShellSessionReady: vi.fn(),
  startSshTask: vi.fn(),
}));
vi.mock('../git/githubCli', () => ({ ghApi: vi.fn(), ghErrorMessage: vi.fn() }));

import type { ShellTaskExtras } from '../agents/sshTaskRunner';
import { RUNNER_TOKEN_PLACEHOLDER } from './runnerInstall';
import { type RunnerInstallDeps, startRunnerInstall } from './runnerInstallTask';

const TOKEN = 'AABBCCDDEEFF00112233';

function input(overrides: Partial<InstallRunnerInput> = {}): InstallRunnerInput {
  return {
    sessionId: 'tab-1',
    target: 'local',
    name: 'build-box',
    repo: 'acme/web',
    mode: 'approve-risky',
    cliId: 'claude-code',
    modelId: null,
    effort: null,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<RunnerInstallDeps> = {}) {
  const started: { input: StartSshAgentTaskInput; extras: ShellTaskExtras }[] = [];
  let clock = 0;
  const deps: RunnerInstallDeps = {
    isReady: () => true,
    fetchToken: vi.fn(async () => TOKEN),
    latestVersion: async () => '2.329.0',
    start: (startInput, _listener, extras) => {
      started.push({ input: startInput, extras });
    },
    machine: () => ({ platform: 'linux', arch: 'x64', homeDir: '/home/me' }),
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
  return { deps, started };
}

describe('startRunnerInstall', () => {
  it('starts a terminal task with a short task line, the guide and the token as a secret', async () => {
    const { deps, started } = fakeDeps();
    await startRunnerInstall(input(), () => undefined, deps);

    expect(started).toHaveLength(1);
    const [{ input: task, extras }] = started;
    expect(task).toEqual({
      sessionId: 'tab-1',
      target: 'local',
      prompt:
        'Install a GitHub Actions self-hosted runner called build-box for acme/web and run it as a service.',
      mode: 'approve-risky',
      cliId: 'claude-code',
      modelId: null,
      effort: null,
    });
    expect(extras.secrets).toEqual({ [RUNNER_TOKEN_PLACEHOLDER]: TOKEN });
    expect(extras.guide).toContain('actions-runner-linux-x64-2.329.0.tar.gz');
    expect(extras.guide).toContain('/home/me/actions-runner/build-box');
    expect(extras.guide).not.toContain(TOKEN);
    expect(JSON.stringify(task)).not.toContain(TOKEN);
  });

  it('lets a server work out its own OS', async () => {
    const { deps, started } = fakeDeps();
    await startRunnerInstall(input({ target: 'ssh' }), () => undefined, deps);
    expect(started[0].input.target).toBe('ssh');
    expect(started[0].extras.guide).toContain('uname -sm');
    expect(started[0].extras.guide).not.toContain('/home/me');
  });

  it('refuses a bad name or repo before asking GitHub for a token', async () => {
    const { deps, started } = fakeDeps();
    await expect(
      startRunnerInstall(input({ name: 'my box' }), () => undefined, deps),
    ).rejects.toThrow(/letters, digits/);
    await expect(
      startRunnerInstall(input({ repo: 'nope' }), () => undefined, deps),
    ).rejects.toThrow(/owner\/name/);
    await expect(
      startRunnerInstall(input({ target: 'rdp' as 'ssh' }), () => undefined, deps),
    ).rejects.toThrow(/this computer or a saved server/);
    expect(deps.fetchToken).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it('passes a GitHub refusal on and starts nothing', async () => {
    const { deps, started } = fakeDeps({
      fetchToken: async () => {
        throw new Error('GitHub would not make a runner token for acme/web.');
      },
    });
    await expect(startRunnerInstall(input(), () => undefined, deps)).rejects.toThrow(
      'GitHub would not make a runner token for acme/web.',
    );
    expect(started).toEqual([]);
  });

  it('waits for the new tab to connect before starting', async () => {
    let checks = 0;
    const { deps, started } = fakeDeps({ isReady: () => ++checks > 3 });
    await startRunnerInstall(input(), () => undefined, deps);
    expect(checks).toBe(4);
    expect(started).toHaveLength(1);
  });

  it('gives up with a clear message when the tab never connects', async () => {
    const { deps, started } = fakeDeps({ isReady: () => false });
    await expect(
      startRunnerInstall(input({ target: 'ssh' }), () => undefined, deps),
    ).rejects.toThrow(
      'The SSH session did not connect in time. Check the server in Remote and try again.',
    );
    expect(started).toEqual([]);
  });
});
