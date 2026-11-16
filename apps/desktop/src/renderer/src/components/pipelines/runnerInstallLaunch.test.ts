import type { SshAgentProgress, SshSavedServer } from '@shared/apiTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSshAgentStore } from '@/stores/sshAgentStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { currentBridge, type FakeBridge } from '../../../../test/renderer/runovaBridge';
import { launchRunnerInstall, type RunnerInstallRequest } from './runnerInstallLaunch';

let bridge: FakeBridge;

const server: SshSavedServer = {
  id: 'srv-1',
  nickname: 'Hetzner',
  host: 'h.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 0,
  lastConnectedAt: null,
};

function request(patch: Partial<RunnerInstallRequest> = {}): RunnerInstallRequest {
  return {
    where: { kind: 'local' },
    name: 'build-box',
    repo: 'acme/web',
    mode: 'approve-risky',
    ai: { cliId: 'claude-code', modelId: null, effort: null },
    ...patch,
  };
}

function progress(sessionId: string, patch: Partial<SshAgentProgress>): SshAgentProgress {
  return { sessionId, phase: 'thinking', step: 1, ...patch };
}

beforeEach(() => {
  bridge = currentBridge();
  bridge.$set('settings.get', async () => ({
    runnerMachineLinks: { 'acme/api/old': { kind: 'local' } },
  }));
  useTerminalStore.setState({ sessions: [], activeSessionId: null, isOpen: false });
  useSshAgentStore.setState({ sessions: {} });
});

describe('launchRunnerInstall', () => {
  it('opens a shell tab named after the runner and asks main to install there', async () => {
    const sessionId = await launchRunnerInstall(request(), { onInstalled: vi.fn() });

    const terminal = useTerminalStore.getState();
    const tab = terminal.sessions.find((s) => s.id === sessionId);
    expect(tab?.title).toBe('Runner build-box');
    expect(tab?.kind).toBeUndefined();
    expect(terminal.activeSessionId).toBe(sessionId);
    expect(terminal.isOpen).toBe(true);
    expect(bridge.$fn('sshAgent.installRunner')).toHaveBeenCalledWith({
      sessionId,
      target: 'local',
      name: 'build-box',
      repo: 'acme/web',
      mode: 'approve-risky',
      cliId: 'claude-code',
      modelId: null,
      effort: null,
    });
  });

  it('opens an SSH tab on the server for a server install', async () => {
    const sessionId = await launchRunnerInstall(request({ where: { kind: 'ssh', server } }), {
      onInstalled: vi.fn(),
    });
    const tab = useTerminalStore.getState().sessions.find((s) => s.id === sessionId);
    expect(tab).toMatchObject({ kind: 'ssh', sshServerId: 'srv-1', title: 'Runner build-box' });
    expect(bridge.$fn('sshAgent.installRunner')).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, target: 'ssh' }),
    );
  });

  it('closes the tab it opened when main refuses, and lets the error through', async () => {
    bridge.$set('sshAgent.installRunner', async () => {
      throw new Error('GitHub would not make a runner token for acme/web.');
    });
    await expect(launchRunnerInstall(request(), { onInstalled: vi.fn() })).rejects.toThrow(
      'GitHub would not make a runner token',
    );
    expect(useTerminalStore.getState().sessions).toEqual([]);
    expect(bridge.$listenerCount('sshAgent.onProgress')).toBe(0);
  });

  it('links the runner to its machine once the AI finishes, keeping the other links', async () => {
    const onInstalled = vi.fn();
    const sessionId = await launchRunnerInstall(request({ where: { kind: 'ssh', server } }), {
      onInstalled,
    });
    bridge.$emit('sshAgent.onProgress', progress('someone-else', { phase: 'finished' }));
    expect(onInstalled).not.toHaveBeenCalled();

    bridge.$emit('sshAgent.onProgress', progress(sessionId, { phase: 'finished', message: 'ok' }));
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(bridge.$fn('settings.update')).toHaveBeenCalledWith({
      runnerMachineLinks: {
        'acme/api/old': { kind: 'local' },
        'acme/web/build-box': { kind: 'ssh', serverId: 'srv-1' },
      },
    });
    expect(bridge.$listenerCount('sshAgent.onProgress')).toBe(0);
  });

  it('keeps listening through a pause, and gives up when the run is stopped', async () => {
    const onInstalled = vi.fn();
    const sessionId = await launchRunnerInstall(request(), { onInstalled });

    bridge.$emit('sshAgent.onProgress', progress(sessionId, { phase: 'error', canContinue: true }));
    expect(bridge.$listenerCount('sshAgent.onProgress')).toBe(1);

    bridge.$emit('sshAgent.onProgress', progress(sessionId, { phase: 'stopped' }));
    expect(bridge.$listenerCount('sshAgent.onProgress')).toBe(0);
    // Nothing is linked either: onInstalled runs only after the link is saved.
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
