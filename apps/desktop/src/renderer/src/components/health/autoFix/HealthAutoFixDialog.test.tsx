import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_AI, useDeployAssistantStore } from '@/stores/deployAssistantStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { project, target } from '../testing/fixtures';

const launch = vi.hoisted(() => ({
  launchPromptTab: vi.fn((): string | null => 'tab-1'),
}));
vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: launch.launchPromptTab,
  projectCliId: (one: { cliId?: string }) => one.cliId ?? null,
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { HealthAutoFixDialog } = await import('./HealthAutoFixDialog');

/**
 * Monitoring's Auto fix: the prompt built from the last report, the project (the monitor's own
 * unless changed), and the two places it can run: a Workspace terminal with the CLI, model,
 * effort and permission mode picked here, or the Deploy AI on the monitor's app.
 */

const PROMPT = 'Fix the failing postgres connection.';
const PROJECTS = [project(), project({ id: 'p2', name: 'Admin', folderPath: 'C:\\work\\admin' })];
const APP = { serverId: 'srv-1', stackId: 'stack-1' };
const onOpenChange = vi.fn();

function renderDialog(
  overrides: Parameters<typeof target>[0] = {},
  bridge: Record<string, unknown> = {},
) {
  function Harness(): React.JSX.Element {
    const location = useLocation();
    return (
      <>
        <HealthAutoFixDialog
          target={target({ state: 'fail', headline: 'postgres: connection refused', ...overrides })}
          projects={PROJECTS}
          open
          onOpenChange={onOpenChange}
        />
        <p data-testid="location">{`${location.pathname}${location.search}`}</p>
      </>
    );
  }
  return renderWithProviders(<Harness />, {
    route: '/monitoring',
    bridge: {
      'health.fixPrompt': async () => PROMPT,
      'cli.detectAll': [
        { id: 'claude-code', installed: true },
        { id: 'codex-cli', installed: true },
      ],
      ...bridge,
    },
  });
}

async function dialog() {
  const view = await screen.findByRole('dialog', { name: 'Auto fix API' });
  await within(view).findByDisplayValue(PROMPT);
  return view;
}

function location(): string {
  return screen.getByTestId('location').textContent ?? '';
}

async function pick(
  user: UserEvent,
  view: HTMLElement,
  field: string,
  option: string | RegExp,
): Promise<void> {
  await user.click(within(view).getByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  launch.launchPromptTab.mockClear();
  launch.launchPromptTab.mockReturnValue('tab-1');
  onOpenChange.mockClear();
  toast.success.mockClear();
  useDeployAssistantStore.setState({
    openServerId: null,
    pageServerId: null,
    draft: null,
    prompts: {},
    runs: {},
    ai: SETTINGS_AI,
    projects: {},
    dismissedApps: {},
    continueFrom: {},
    requestedModes: {},
  });
});

describe('HealthAutoFixDialog', () => {
  it('loads the fix prompt and starts on the monitor’s own project', async () => {
    const { bridge } = renderDialog();
    const view = await dialog();

    expect(bridge.$fn('health.fixPrompt')).toHaveBeenCalledWith('t1');
    expect(within(view).getByRole('combobox', { name: 'Project' })).toHaveTextContent('Storefront');
    expect(within(view).getByRole('radio', { name: 'Workspace terminal' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The project's own CLI is the one picked to begin with.
    expect(within(view).getByRole('combobox', { name: 'CLI' })).toHaveTextContent('Claude Code');
  });

  it('runs the prompt in a Workspace terminal with the CLI, model, effort and permissions picked', async () => {
    const { user } = renderDialog();
    const view = await dialog();

    await pick(user, view, 'Project', 'Admin');
    await pick(user, view, 'Model', 'Opus 5.5');
    await user.click(within(view).getByRole('radio', { name: 'High' }));
    await pick(user, view, 'Permissions', 'Accept edits');
    await user.clear(within(view).getByLabelText('Fix prompt'));
    await user.type(within(view).getByLabelText('Fix prompt'), 'Fix it now.');
    await user.click(within(view).getByRole('button', { name: 'Run in Workspace' }));

    expect(launch.launchPromptTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }), {
      cliId: 'claude-code',
      prompt: 'Fix it now.',
      runArgs: ['--model', 'opus', '--effort', 'high', '--permission-mode', 'acceptEdits'],
      runLabel: 'Opus 5.5 · High · Accept edits',
      submit: true,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(location()).toBe('/workspace/p2'));
  });

  it('can open the terminal with the prompt typed in, leaving Enter to the user', async () => {
    const { user } = renderDialog();
    const view = await dialog();

    await pick(user, view, 'CLI', 'Codex CLI');
    await user.click(within(view).getByRole('button', { name: 'Open in Workspace' }));

    expect(launch.launchPromptTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({ cliId: 'codex-cli', prompt: PROMPT, runArgs: [], submit: false }),
    );
  });

  it('warns before a permission mode that asks for nothing', async () => {
    const { user } = renderDialog();
    const view = await dialog();
    expect(within(view).queryByText(/runs every command and edit without asking/)).toBeNull();

    await pick(user, view, 'Permissions', /Bypass permissions/);

    expect(within(view).getByText(/runs every command and edit without asking/)).toBeVisible();
  });

  it('copies the prompt', async () => {
    const { user } = renderDialog();
    const view = await dialog();

    await user.click(within(view).getByRole('button', { name: 'Copy prompt' }));

    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(PROMPT));
  });

  it('offers the Deploy AI only for a monitor added from a Deploy app', async () => {
    renderDialog({ appLink: null });
    const view = await dialog();

    expect(within(view).getByRole('radio', { name: 'Deploy AI' })).toBeDisabled();
    expect(within(view).getByText(/needs a monitor added from a Deploy app/)).toBeVisible();
  });

  it('opens the app on the Deploy page with the Deploy AI ready to run the prompt', async () => {
    const { user } = renderDialog({ appLink: APP });
    const view = await dialog();

    await user.click(within(view).getByRole('radio', { name: 'Deploy AI' }));
    await pick(user, view, 'AI', /Claude Code/);
    await pick(user, view, 'Model', 'Opus 5.5');
    await user.click(within(view).getByRole('radio', { name: 'Low' }));
    await user.click(within(view).getByRole('radio', { name: 'Auto-run diagnostics' }));
    await user.click(within(view).getByRole('radio', { name: 'Read and edit' }));
    await user.click(within(view).getByRole('button', { name: 'Open in Deploy AI' }));

    const state = useDeployAssistantStore.getState();
    expect(state.openServerId).toBe('srv-1');
    expect(state.prompts['srv-1']).toBe(PROMPT);
    expect(state.draft?.context.title).toBe('Down: API');
    expect(state.ai).toMatchObject({ cliId: 'claude-code', effort: 'low' });
    expect(state.ai.modelId).toBeTruthy();
    expect(state.projects['srv-1']).toEqual({ projectId: 'p1', allowEdits: true });
    expect(state.requestedModes['srv-1']).toBe('autoRunDiagnostics');
    expect(launch.launchPromptTab).not.toHaveBeenCalled();
    await waitFor(() => expect(location()).toBe('/deploy?server=srv-1&view=apps&app=stack-1'));
  });

  it('starts a new Deploy AI chat and keeps the command mode unless asked', async () => {
    useDeployAssistantStore.setState({
      runs: {
        'srv-1': {
          prompt: 'Earlier question',
          progress: { sessionId: 'deploy:srv-1', phase: 'finished', step: 2 },
          steps: [],
          messages: [],
          earlier: [],
        },
      },
    });
    const { user } = renderDialog({ appLink: APP });
    const view = await dialog();

    await user.click(within(view).getByRole('radio', { name: 'Deploy AI' }));
    await user.click(within(view).getByRole('button', { name: 'Open in Deploy AI' }));

    const state = useDeployAssistantStore.getState();
    expect(state.runs['srv-1']?.prompt).toBeUndefined();
    expect(state.ai).toEqual(SETTINGS_AI);
    expect(state.requestedModes['srv-1']).toBeUndefined();
  });

  it('will not take over a Deploy AI run that is still going', async () => {
    useDeployAssistantStore.setState({
      runs: {
        'srv-1': {
          progress: { sessionId: 'deploy:srv-1', phase: 'thinking', step: 1 },
          steps: [],
          messages: [],
          earlier: [],
        },
      },
    });
    const { user } = renderDialog({ appLink: APP });
    const view = await dialog();

    await user.click(within(view).getByRole('radio', { name: 'Deploy AI' }));

    expect(within(view).getByText(/busy on this server/)).toBeVisible();
    expect(within(view).getByRole('button', { name: 'Open in Deploy AI' })).toBeDisabled();
  });

  it('says so when nothing is failing any more', async () => {
    renderDialog({}, { 'health.fixPrompt': async () => null });

    expect(await screen.findByText(/Nothing is failing right now/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run in Workspace' })).toBeDisabled();
  });
});
