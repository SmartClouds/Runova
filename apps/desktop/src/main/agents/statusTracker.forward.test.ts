import { afterEach, describe, expect, it, vi } from 'vitest';

const forwarded = vi.hoisted(() => [] as unknown[]);

vi.mock('../ipc/send', () => ({ broadcastToWindows: () => undefined }));
vi.mock('../mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('../notifications/osNotification', () => ({ showOsNotification: () => true }));
vi.mock('../notifications/petNotifier', () => ({ speakOnPet: () => true }));
vi.mock('../notifications/forward', () => ({
  forwardNotification: (event: unknown) => forwarded.push(event),
}));
vi.mock('../power/keepAwake', () => ({ keepAwake: { setBusy: () => undefined } }));
vi.mock('../worktrees/resolve', () => ({ scopeDisplayName: async () => 'Shop' }));
vi.mock('../store', () => ({
  store: {
    getSettings: async () => ({ workspaceNotifications: false }),
    updateSettings: async () => undefined,
    getLastRunInfoByCli: async () => ({}),
    setLastRunInfoByCli: async () => undefined,
  },
}));

const { agentStatus } = await import('./statusTracker');

describe('agent notices reach the phone by category alone', () => {
  afterEach(() => {
    forwarded.length = 0;
    agentStatus.unpin('tab-1');
    agentStatus.sync([]);
  });

  async function waitForForward(): Promise<void> {
    await vi.waitFor(() => expect(forwarded.length).toBeGreaterThan(0), { timeout: 3000 });
  }

  it('says who needs input in which project, and nothing the terminal wrote', async () => {
    agentStatus.pin({
      sessionId: 'tab-1',
      projectId: 'proj-1',
      cliId: 'claude-code',
      title: 'npm ERR! tab title set by the terminal',
    });

    agentStatus.hook('tab-1', 'needs-input', 'rm -rf ~/ was about to run, secret=abc123');

    await waitForForward();
    expect(forwarded).toEqual([
      expect.objectContaining({
        category: 'agent-needs-input',
        project: 'Shop',
        itemId: 'proj-1',
      }),
    ]);
    const sent = JSON.stringify(forwarded);
    expect(sent).not.toContain('npm ERR');
    expect(sent).not.toContain('rm -rf');
    expect(sent).not.toContain('secret');
  });

  it('forwards finishing too, even with desktop notifications turned off', async () => {
    agentStatus.pin({ sessionId: 'tab-1', projectId: 'proj-1', cliId: 'claude-code', title: 't' });

    agentStatus.hook('tab-1', 'stop');

    await waitForForward();
    expect(forwarded[0]).toMatchObject({ category: 'agent-finished', project: 'Shop' });
  });
});
