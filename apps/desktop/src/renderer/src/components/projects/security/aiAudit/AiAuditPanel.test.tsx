import type { AiAuditRunDetail, AiAuditRunSummary, AiAuditStatus, Project } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const launch = vi.hoisted(() => ({
  launchPromptTab: vi.fn((..._args: unknown[]) => 'tab-1' as string | null),
  launchSetupTab: vi.fn((..._args: unknown[]) => 'setup-1'),
  startTabNow: vi.fn(),
  projectCliId: vi.fn(() => 'claude-code'),
}));
vi.mock('@/lib/workspace/launch', () => launch);

const confirmDialog = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('@/stores/confirmStore', async (original) => ({
  ...(await original<typeof import('@/stores/confirmStore')>()),
  confirmDialog,
}));

const { AiAuditPanel } = await import('./AiAuditPanel');
const { ProjectUiScope } = await import('@/hooks/useProjectUiState');
const { projectUiKey, useProjectUiStore } = await import('@/stores/projectUiStore');

/**
 * The AI audit half of the Security tab, in each state someone meets it: never set up, set up but
 * never run, running, and finished.
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

function summary(over: Partial<AiAuditRunSummary> = {}): AiAuditRunSummary {
  return {
    runName: 'run-2',
    outputDir: '/home/me/security-audit-skill/shop/run-2',
    phase: 'complete',
    metadata: { runStatus: 'complete', incompleteReason: null, profile: 'standard', target: null },
    counts: {
      confirmed: 1,
      needsValidation: 0,
      rejected: 0,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0, informational: 0 },
    },
    ledger: null,
    startedAt: '2026-11-08T10:00:00Z',
    lastActivityAt: '2026-11-08T11:00:00Z',
    hasReport: true,
    ...over,
  };
}

const sqli = {
  verdict: 'confirmed' as const,
  fingerprint: 'sqli:1',
  title: 'SQL injection in user search',
  description: '',
  root_cause: '',
  intended_behavior: '',
  trace: [{ kind: 'sink' as const, file: 'src/db/users.ts', line: 42, scope: '', description: '' }],
  evidence: [],
  conditions: [],
  execution: { attacker_perspective: '', payloads: [], instructions: [], observed_result: '' },
  remediation: { strategy: 'Parameterize.' },
  severity: {
    likelihood: { score: 'high' as const, reason: '' },
    impact: { score: 'high' as const, reason: '' },
    overall_severity: 'high' as const,
  },
  confidence: { score: 'high' as const, reason: '' },
};

function detail(over: Partial<AiAuditRunDetail> = {}): AiAuditRunDetail {
  return { ...summary(), findings: [sqli], droppedFindings: 0, report: '# Report', ...over };
}

function setup(bridge: Record<string, unknown>) {
  return renderWithProviders(<AiAuditPanel project={project} />, {
    bridge: {
      'securityAudit.status': installed,
      'cli.detectAll': [{ id: 'claude-code', installed: true, version: '2.5.0' }],
      ...bridge,
    },
  });
}

beforeEach(() => {
  navigate.mockClear();
  launch.launchPromptTab.mockClear();
});

describe('AiAuditPanel', () => {
  it('introduces the audit in a project that has never used it', async () => {
    const { user } = setup({
      'securityAudit.status': { ...installed, installed: false, locations: [] },
    });

    expect(await screen.findByText(/Find what scanners miss/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Set up AI audit/ }));

    expect(await screen.findByText('Run an AI security audit')).toBeInTheDocument();
  });

  it('goes straight to configuring the first run once the skill is installed', async () => {
    const { user } = setup({});

    await user.click(await screen.findByRole('button', { name: /Start your first audit/ }));

    expect(await screen.findByText(/Which agent runs the audit/)).toBeInTheDocument();
  });

  it('tracks a run that is still going', async () => {
    const live = { phase: 'hunting' as const, metadata: null, counts: null, hasReport: false };
    const { user } = setup({
      'securityAudit.listRuns': [summary(live)],
      'securityAudit.getRun': detail({ ...live, findings: [] }),
    });

    expect(await screen.findByText('AI security audit in progress')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New audit/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Open agent tab' }));
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');

    // Nothing recorded which tab this run is in, so it must not claim to have stopped it.
    await user.click(screen.getByRole('button', { name: 'Stop tracking' }));
    expect(await screen.findByText('This audit may still be running')).toBeInTheDocument();
    expect(confirmDialog).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep tracking' }));
    expect(await screen.findByText('AI security audit in progress')).toBeInTheDocument();
  });

  describe('stopping a run whose agent tab is known', () => {
    const live = { phase: 'hunting' as const, metadata: null, counts: null, hasReport: false };

    function setupWithAgent(): { tabId: string; user: ReturnType<typeof setup>['user'] } {
      const store = useWorkspaceStore.getState();
      store.openProject('p1');
      const tabId = store.addTerminal('p1', { title: 'Claude', cwd: '/work/shop', cliId: 'c' });
      useProjectUiStore.setState({
        values: { [projectUiKey('p1', 'security.audit.agentTabs')]: { 'run-2': tabId } },
      });
      const { user } = renderWithProviders(
        <ProjectUiScope.Provider value="p1">
          <AiAuditPanel project={project} />
        </ProjectUiScope.Provider>,
        {
          bridge: {
            'securityAudit.status': installed,
            'securityAudit.listRuns': [summary(live)],
            'securityAudit.getRun': detail({ ...live, findings: [] }),
          },
        },
      );
      return { tabId, user };
    }

    afterEach(() => {
      useWorkspaceStore.getState().closeProject('p1');
      useProjectUiStore.setState({ values: {} });
      confirmDialog.mockClear();
    });

    it('closes the agent once confirmed and says the audit stopped', async () => {
      const { tabId, user } = setupWithAgent();

      await user.click(await screen.findByRole('button', { name: 'Stop audit' }));

      expect(await screen.findByText('Audit stopped')).toBeInTheDocument();
      expect(confirmDialog).toHaveBeenCalledTimes(1);
      expect(useWorkspaceStore.getState().workspaces.p1?.tabs[tabId]).toBeUndefined();
      expect(screen.getByRole('button', { name: /Start a new audit/ })).toBeEnabled();
    });

    it('leaves the agent running when the confirmation is declined', async () => {
      confirmDialog.mockResolvedValueOnce(false);
      const { tabId, user } = setupWithAgent();

      await user.click(await screen.findByRole('button', { name: 'Stop audit' }));

      await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
      expect(useWorkspaceStore.getState().workspaces.p1?.tabs[tabId]).toBeDefined();
      expect(screen.getByText('AI security audit in progress')).toBeInTheDocument();
    });
  });

  it('shows the report of a finished run, with its files a click away', async () => {
    const { user, bridge } = setup({
      'securityAudit.listRuns': [summary()],
      'securityAudit.getRun': detail(),
    });

    expect(await screen.findByText('SQL injection in user search')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /REPORT\.md/ }));
    expect(bridge.$fn('securityAudit.openPath')).toHaveBeenCalledWith('p1', 'run-2', 'report');

    await user.click(screen.getByRole('button', { name: /Open folder/ }));
    expect(bridge.$fn('securityAudit.openPath')).toHaveBeenCalledWith('p1', 'run-2', 'folder');
  });

  it('opens a trace file in the workspace editor at its line', async () => {
    const openFile = vi.spyOn(useWorkspaceStore.getState(), 'openFile');
    const { user } = setup({
      'securityAudit.listRuns': [summary()],
      'securityAudit.getRun': detail(),
    });

    await user.click(await screen.findByRole('button', { name: /SQL injection in user search/ }));
    await user.click(screen.getByRole('button', { name: 'src/db/users.ts:42' }));

    expect(openFile).toHaveBeenCalledWith('p1', '/work/shop/src/db/users.ts', {
      reveal: { line: 42, column: 1 },
    });
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
  });

  it('hands the confirmed findings to the project agent', async () => {
    const { user } = setup({
      'securityAudit.listRuns': [summary()],
      'securityAudit.getRun': detail(),
    });

    await user.click(await screen.findByRole('button', { name: /Fix with agent/ }));

    expect(launch.launchPromptTab).toHaveBeenCalledWith(project, {
      cliId: 'claude-code',
      prompt: expect.stringContaining('SQL injection in user search'),
    });
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
  });

  it('switches to an older run from the history', async () => {
    const { user, bridge } = setup({
      'securityAudit.listRuns': [summary(), summary({ runName: 'run-1' })],
      'securityAudit.getRun': detail(),
    });
    await screen.findByText('SQL injection in user search');

    await user.click(screen.getByRole('button', { name: /run-2/ }));
    await user.click(await screen.findByRole('menuitem', { name: /run-1/ }));

    await waitFor(() =>
      expect(bridge.$fn('securityAudit.getRun')).toHaveBeenCalledWith('p1', 'run-1'),
    );
  });

  it('still shows old reports after the skill was removed, with a way back', async () => {
    setup({
      'securityAudit.status': { ...installed, installed: false, locations: [] },
      'securityAudit.listRuns': [summary()],
      'securityAudit.getRun': detail(),
    });

    expect(await screen.findByText('SQL injection in user search')).toBeInTheDocument();
    expect(screen.getByText(/skill is not installed in Shop/)).toBeInTheDocument();
  });
});
