import type { GithubRunnersResult, RunnerInstallDefaults, SshSavedServer } from '@shared/apiTypes';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useSshAgentStore } from '@/stores/sshAgentStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The Add runner dialog asks for one thing, the runner's name, and fills in everything else from
 * the machine and the projects. Launching the install itself is replaced here.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const launch = vi.hoisted(() => ({
  launchRunnerInstall: vi.fn(async (..._args: unknown[]) => 'tab-1'),
}));
vi.mock('./runnerInstallLaunch', () => launch);

const { AddRunnerDialog } = await import('./AddRunnerDialog');

const DEFAULTS: RunnerInstallDefaults = {
  name: 'desktop-42',
  osLabel: 'Windows',
  arch: 'x64',
  repos: [
    { owner: 'acme', repo: 'web', projectName: 'Web' },
    { owner: 'acme', repo: 'api', projectName: 'API' },
  ],
};

const SERVER: SshSavedServer = {
  id: 'srv-1',
  nickname: 'Hetzner Box',
  host: 'h.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 0,
  lastConnectedAt: null,
};

function bridge(overrides: Record<string, unknown> = {}) {
  return {
    'pipelines.runnerDefaults': DEFAULTS,
    'ssh.listServers': [SERVER],
    'cli.detectAll': [{ id: 'claude-code', installed: true }],
    ...overrides,
  };
}

function client(runnersInCache: GithubRunnersResult | null = null): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  if (runnersInCache) queryClient.setQueryData([...queryKeys.githubRunners, ''], runnersInCache);
  return queryClient;
}

function renderDialog({
  overrides = {},
  preferredRepo,
  queryClient = client(),
}: {
  overrides?: Record<string, unknown>;
  preferredRepo?: string;
  queryClient?: QueryClient;
} = {}) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <AddRunnerDialog open onOpenChange={onOpenChange} preferredRepo={preferredRepo} />,
    { bridge: bridge(overrides), queryClient },
  );
  return { ...view, onOpenChange };
}

async function nameField(): Promise<HTMLInputElement> {
  const field = (await screen.findByRole('textbox', { name: 'Runner name' })) as HTMLInputElement;
  await waitFor(() => expect(field.value).not.toBe(''));
  return field;
}

function installButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Install with AI' });
}

beforeEach(() => {
  launch.launchRunnerInstall.mockClear();
  toast.success.mockClear();
  useSshAgentStore.setState({ lastMode: 'approve-all', lastAi: undefined });
});

describe('AddRunnerDialog', () => {
  it('starts on this computer, named after it, with the repo the page points at', async () => {
    renderDialog({ preferredRepo: 'acme/api' });
    const field = await nameField();
    expect(field.value).toBe('desktop-42');
    expect(field).toHaveFocus();
    expect(screen.getByRole('button', { name: /This computer/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(/acme\/api/)).toBeInTheDocument();
    expect(screen.getByText(/Windows, x64/)).toBeInTheDocument();
  });

  it("falls back to the projects' first repo when the page points at none", async () => {
    renderDialog();
    await nameField();
    expect(screen.getByText(/acme\/web/)).toBeInTheDocument();
  });

  it('names a server install after the server, but keeps a name the user typed', async () => {
    const { user } = renderDialog();
    const field = await nameField();

    await user.click(screen.getByRole('button', { name: /A saved server/ }));
    await waitFor(() => expect(field.value).toBe('hetzner-box'));

    await user.clear(field);
    await user.type(field, 'gpu-1');
    await user.click(screen.getByRole('button', { name: /This computer/ }));
    expect(field.value).toBe('gpu-1');
  });

  it('cannot pick a server when none is saved', async () => {
    renderDialog({ overrides: { 'ssh.listServers': [] } });
    await nameField();
    expect(screen.getByRole('button', { name: /A saved server/ })).toBeDisabled();
  });

  it('explains a name GitHub would refuse and holds the install back', async () => {
    const { user } = renderDialog();
    const field = await nameField();
    await user.clear(field);
    await user.type(field, 'my box');

    expect(
      screen.getByText('Use only letters, digits, dots, dashes and underscores.'),
    ).toBeVisible();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(installButton()).toBeDisabled();
  });

  it('flags a name a runner on the repo already has', async () => {
    renderDialog({
      queryClient: client({
        ok: true,
        waiting: [],
        hiddenOrgs: [],
        runners: [
          {
            name: 'desktop-42',
            scope: { kind: 'repo', name: 'acme/web' },
            os: 'Windows',
            state: 'idle',
            labels: [],
            customLabels: [],
          },
        ],
      }),
    });
    await nameField();
    expect(
      await screen.findByText('A runner called desktop-42 is already registered here.'),
    ).toBeVisible();
    expect(installButton()).toBeDisabled();
  });

  it('launches the install with the defaults and closes', async () => {
    const { user, onOpenChange } = renderDialog();
    await nameField();
    await waitFor(() => expect(installButton()).toBeEnabled());
    await user.click(installButton());

    await waitFor(() => expect(launch.launchRunnerInstall).toHaveBeenCalledTimes(1));
    expect(launch.launchRunnerInstall.mock.calls[0][0]).toEqual({
      where: { kind: 'local' },
      name: 'desktop-42',
      repo: 'acme/web',
      mode: 'approve-all',
      ai: { cliId: 'claude-code', modelId: null, effort: null },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('sends a server install to that server', async () => {
    const { user } = renderDialog();
    await nameField();
    await user.click(screen.getByRole('button', { name: /A saved server/ }));
    await waitFor(() => expect(installButton()).toBeEnabled());
    await user.click(installButton());

    await waitFor(() => expect(launch.launchRunnerInstall).toHaveBeenCalledTimes(1));
    expect(launch.launchRunnerInstall.mock.calls[0][0]).toMatchObject({
      where: { kind: 'ssh', server: { id: 'srv-1' } },
      name: 'hetzner-box',
    });
  });

  it('installs on Enter in the name field', async () => {
    const { user } = renderDialog();
    const field = await nameField();
    await waitFor(() => expect(installButton()).toBeEnabled());
    await user.type(field, '{Enter}');
    await waitFor(() => expect(launch.launchRunnerInstall).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog open with the reason when the install cannot start', async () => {
    launch.launchRunnerInstall.mockRejectedValueOnce(
      new Error('GitHub would not make a runner token for acme/web.'),
    );
    const { user, onOpenChange } = renderDialog();
    await nameField();
    await waitFor(() => expect(installButton()).toBeEnabled());
    await user.click(installButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub would not make a runner token for acme/web.',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('says so when no project has a GitHub repo', async () => {
    renderDialog({ overrides: { 'pipelines.runnerDefaults': { ...DEFAULTS, repos: [] } } });
    await nameField();
    expect(await screen.findByText(/None of your projects has a GitHub repo/)).toBeVisible();
    expect(installButton()).toBeDisabled();
  });

  it('lets the details be changed: repo, AI and approvals', async () => {
    const { user } = renderDialog();
    await nameField();
    await user.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByRole('combobox', { name: 'Repository' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'AI' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Approvals' })).toBeVisible();
    expect(screen.getByText(/Runs as a service/)).toBeVisible();
  });

  it('tells the user and refreshes the runners once the AI is done', async () => {
    const queryClient = client();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { user } = renderDialog({ queryClient });
    await nameField();
    await waitFor(() => expect(installButton()).toBeEnabled());
    await user.click(installButton());
    await waitFor(() => expect(launch.launchRunnerInstall).toHaveBeenCalledTimes(1));

    const { onInstalled } = launch.launchRunnerInstall.mock.calls[0][1] as {
      onInstalled: () => void;
    };
    onInstalled();
    expect(toast.success).toHaveBeenCalledWith('Runner desktop-42 is installed and running.');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.githubRunners });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.settings });
  });
});
