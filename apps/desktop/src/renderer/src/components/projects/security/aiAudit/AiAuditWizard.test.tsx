import type { AiAuditStatus, Project } from '@runova/core';
import { cliLaunchOptions, launchDefaultArgs } from '@runova/core';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const launch = vi.hoisted(() => ({
  launchPromptTab: vi.fn((..._args: unknown[]) => 'tab-1' as string | null),
  launchSetupTab: vi.fn((..._args: unknown[]) => 'setup-1'),
  startTabNow: vi.fn(),
  projectCliId: vi.fn(() => 'claude-code'),
}));
vi.mock('@/lib/workspace/launch', () => launch);
// xterm needs a real canvas; what matters here is whether the terminal is on screen.
vi.mock('@/components/workspace/TerminalSlot', () => ({ TerminalSlot: () => 'live terminal' }));

const { useAiAudit } = await import('./useAiAudit');
const { AiAuditWizard } = await import('./AiAuditWizard');
const { useWorkspaceStore } = await import('@/stores/workspaceStore');

function openSetupTab(): string {
  const store = useWorkspaceStore.getState();
  store.openProject('p1');
  const tabId = store.addTerminal('p1', { title: 'Setup', cwd: '/work/shop' });
  launch.launchSetupTab.mockReturnValue(tabId);
  return tabId;
}

/**
 * The wizard from start to launch: what it checks, installing the skill into the project (it is a
 * per-project install), picking the agent, depth and scope, and starting the run.
 */

const project = {
  id: 'p1',
  name: 'Shop',
  folderPath: '/work/shop',
  agentType: 'claude-code',
} as Project;

const installed: AiAuditStatus = {
  installed: true,
  locations: [{ path: '.claude/skills/security-audit', scope: 'project' }],
  node: { found: true, version: 'v22.20.0', meetsMinimum: true },
  runsRoot: '/home/me/security-audit-skill/shop',
};
const notInstalled: AiAuditStatus = { ...installed, installed: false, locations: [] };

function Harness({
  onOpenChange,
  initialStep,
}: {
  onOpenChange: (open: boolean) => void;
  initialStep?: 'overview' | 'configure';
}) {
  const audit = useAiAudit(project);
  return (
    <AiAuditWizard
      open
      onOpenChange={onOpenChange}
      project={project}
      audit={audit}
      initialStep={initialStep}
    />
  );
}

function setup(
  options: {
    status?: AiAuditStatus;
    initialStep?: 'overview' | 'configure';
    codexInstalled?: boolean;
  } = {},
) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <Harness onOpenChange={onOpenChange} initialStep={options.initialStep} />,
    {
      bridge: {
        'securityAudit.status': options.status ?? installed,
        'securityAudit.prepareRun': {
          runName: 'run-1',
          outputDir: '/home/me/security-audit-skill/shop/run-1',
        },
        'cli.detectAll': [
          { id: 'claude-code', installed: true, version: '2.5.0' },
          {
            id: 'codex-cli',
            installed: options.codexInstalled ?? false,
            version: options.codexInstalled ? '1.0.0' : null,
          },
        ],
      },
    },
  );
  return { ...view, onOpenChange };
}

beforeEach(() => {
  launch.launchPromptTab.mockClear();
  launch.launchSetupTab.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  useWorkspaceStore.getState().closeProject('p1');
});

describe('AiAuditWizard', () => {
  it('checks the machine and the project before anything is installed', async () => {
    setup({ status: notInstalled });

    expect(await screen.findByText('Run an AI security audit')).toBeInTheDocument();
    expect(await screen.findByText(/Not installed in Shop yet/)).toBeInTheDocument();
    expect(screen.getByText(/v22\.20\.0/)).toBeInTheDocument();
    expect(await screen.findByText(/Claude Code is ready/)).toBeInTheDocument();
  });

  it('installs the skill into the project, then moves on once it lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, bridge } = setup({ status: notInstalled });

    await user.click(await screen.findByRole('button', { name: /Continue/ }));
    expect(await screen.findByText(/Install the skill into Shop/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Claude Code/ })).toBeChecked();
    expect(
      screen.getByText(
        'npx -y skills add https://github.com/cloudflare/security-audit-skill --skill security-audit --agent claude-code -y',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
    openSetupTab();

    await user.click(screen.getByRole('button', { name: /Install into Shop/ }));

    expect(launch.launchSetupTab).toHaveBeenCalledWith(
      project,
      expect.stringContaining('npx -y skills add'),
    );
    expect(await screen.findByText(/Waiting for the install to finish/)).toBeInTheDocument();

    bridge.$set('securityAudit.status', installed);
    await act(() => vi.advanceTimersByTimeAsync(2_500));

    expect(await screen.findByText(/Which agent runs the audit/)).toBeInTheDocument();
  });

  it('folds the install terminal away until it is asked for, and can give up', async () => {
    const { user } = setup({ status: notInstalled });
    await user.click(await screen.findByRole('button', { name: /Continue/ }));
    const tabId = openSetupTab();
    await user.click(await screen.findByRole('button', { name: /Install into Shop/ }));

    const fold = await screen.findByRole('button', { name: /Terminal output/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('live terminal')).not.toBeInTheDocument();

    await user.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('live terminal')).toBeInTheDocument();

    await user.click(fold);
    expect(screen.queryByText('live terminal')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(await screen.findByRole('button', { name: /Install into Shop/ })).toBeEnabled();
    expect(useWorkspaceStore.getState().workspaces.p1?.tabs[tabId]).toBeUndefined();
  });

  it('will not install without a recent enough Node', async () => {
    const { user } = setup({
      status: { ...notInstalled, node: { found: true, version: 'v20.11.0', meetsMinimum: false } },
    });

    await user.click(await screen.findByRole('button', { name: /Continue/ }));

    expect(await screen.findByRole('button', { name: /Install into Shop/ })).toBeDisabled();
    expect(screen.getAllByText(/Node\.js 22\.20 or later/).length).toBeGreaterThan(0);
  });

  it('skips the install for a project that already has the skill', async () => {
    const { user } = setup();

    await user.click(await screen.findByRole('button', { name: /Continue/ }));

    expect(await screen.findByText(/Which agent runs the audit/)).toBeInTheDocument();
  });

  it('only offers agents that are installed', async () => {
    setup({ initialStep: 'configure' });

    // Enabled once the installed agents have been detected.
    await waitFor(() => expect(screen.getByRole('radio', { name: /Claude Code/ })).toBeEnabled());
    expect(screen.getByRole('radio', { name: /Codex/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Claude Code/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('starts the audit with the depth and folders picked', async () => {
    const { user, onOpenChange } = setup({ initialStep: 'configure' });

    await user.click(await screen.findByRole('radio', { name: /Deep/ }));
    await user.click(screen.getByRole('radio', { name: /Only some folders/ }));
    await user.type(screen.getByLabelText('Folder to include'), 'src/api{Enter}');
    await user.type(screen.getByLabelText('Folder to include'), '../secrets{Enter}');
    expect(screen.getByText(/inside the project/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    expect(await screen.findByText(/Profile: deep/)).toBeInTheDocument();
    expect(screen.getByText(/Only these paths: src\/api/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Start audit/ }));

    await waitFor(() =>
      expect(launch.launchPromptTab).toHaveBeenCalledWith(project, {
        cliId: 'claude-code',
        prompt: expect.stringMatching(/Profile: deep[\s\S]*src\/api[\s\S]*run-1/),
        submit: true,
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('runs the agent on the model and effort picked after the CLI', async () => {
    const { user } = setup({ initialStep: 'configure' });
    const model = cliLaunchOptions('claude-code')?.models.find((m) => m.efforts?.includes('high'));
    if (!model) throw new Error('The catalog has no Claude model with a high effort');

    await user.click(await screen.findByRole('combobox', { name: 'Model' }));
    await user.click(await screen.findByRole('option', { name: new RegExp(model.label) }));
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await user.click(screen.getByRole('button', { name: /Continue/ }));

    expect(await screen.findByText('High effort')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Start audit/ }));

    await waitFor(() =>
      expect(launch.launchPromptTab).toHaveBeenCalledWith(
        project,
        expect.objectContaining({
          cliId: 'claude-code',
          runArgs: launchDefaultArgs('claude-code', { model: model.value, effort: 'high' }),
          runLabel: `${model.label} · High`,
        }),
      ),
    );
  });

  it('leaves the model and effort to the CLI when none is picked', async () => {
    const { user } = setup({ initialStep: 'configure' });

    await screen.findByRole('radio', { name: 'High' });
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await user.click(await screen.findByRole('button', { name: /Start audit/ }));

    await waitFor(() => expect(launch.launchPromptTab).toHaveBeenCalled());
    const launched = launch.launchPromptTab.mock.calls[0]?.[1] as { runArgs?: string[] };
    expect(launched.runArgs).toBeUndefined();
  });

  it('does not carry a choice over to another CLI', async () => {
    const { user } = setup({ initialStep: 'configure', codexInstalled: true });

    await user.click(await screen.findByRole('radio', { name: 'High' }));
    expect(screen.getByRole('radio', { name: 'High' })).toBeChecked();
    await waitFor(() => expect(screen.getByRole('radio', { name: /Codex/ })).toBeEnabled());

    await user.click(screen.getByRole('radio', { name: /Codex/ }));

    expect(screen.getByRole('radio', { name: 'Not set' })).toBeChecked();
  });

  it('cannot continue to scope a run with no folders picked', async () => {
    const { user } = setup({ initialStep: 'configure' });

    await user.click(await screen.findByRole('radio', { name: /Only some folders/ }));

    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });
});
