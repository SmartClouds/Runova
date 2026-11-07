import type { AiAuditRunDetail, AiAuditRunSummary, Project } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithProviders } from '../../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const launch = vi.hoisted(() => ({
  launchPromptTab: vi.fn((..._args: unknown[]) => 'tab-1' as string | null),
  launchSetupTab: vi.fn((..._args: unknown[]) => 'setup-1'),
}));
vi.mock('@/lib/workspace/launch', () => launch);

const { useAiAudit } = await import('./useAiAudit');

/**
 * The AI audit's data layer. The agent writes the run folder; this hook finds the run, keeps it
 * fresh while the agent is working, and stops looking once the run has ended.
 */

const project = { id: 'p1', name: 'Shop', folderPath: '/work/shop' } as Project;

function summary(over: Partial<AiAuditRunSummary> = {}): AiAuditRunSummary {
  return {
    runName: 'run-1',
    outputDir: '/home/me/security-audit-skill/shop/run-1',
    phase: 'complete',
    metadata: { runStatus: 'complete', incompleteReason: null, profile: 'standard', target: null },
    counts: {
      confirmed: 1,
      needsValidation: 0,
      rejected: 0,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0, informational: 0 },
    },
    ledger: null,
    startedAt: '2026-11-01T10:00:00Z',
    lastActivityAt: '2026-11-01T11:00:00Z',
    hasReport: true,
    ...over,
  };
}

function detail(over: Partial<AiAuditRunDetail> = {}): AiAuditRunDetail {
  return { ...summary(), findings: [], droppedFindings: 0, report: '# Report', ...over };
}

const live = { phase: 'hunting' as const, metadata: null, counts: null, hasReport: false };

function setup(bridge: Record<string, unknown> = {}) {
  return renderHookWithProviders(() => useAiAudit(project), {
    bridge: {
      'securityAudit.status': {
        installed: true,
        locations: [{ path: '.claude/skills/security-audit', scope: 'project' }],
        node: { found: true, version: 'v22.20.0', meetsMinimum: true },
        runsRoot: '/home/me/security-audit-skill/shop',
      },
      ...bridge,
    },
  });
}

beforeEach(() => {
  launch.launchPromptTab.mockClear();
  launch.launchSetupTab.mockClear();
  toast.success.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAiAudit', () => {
  it('opens the newest run and reads it', async () => {
    const { result, bridge } = setup({
      'securityAudit.listRuns': [summary({ runName: 'run-2' }), summary({ runName: 'run-1' })],
      'securityAudit.getRun': detail({ runName: 'run-2' }),
    });

    await waitFor(() => expect(result.current.run?.runName).toBe('run-2'));
    expect(result.current.selectedRunName).toBe('run-2');
    expect(bridge.$fn('securityAudit.getRun')).toHaveBeenCalledWith('p1', 'run-2');
    expect(result.current.live).toBe(false);
  });

  it('keeps a running audit fresh, then stops and says so when it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result, bridge } = setup({
      'securityAudit.listRuns': [summary(live)],
      'securityAudit.getRun': detail(live),
    });
    await waitFor(() => expect(result.current.live).toBe(true));
    const callsBefore = bridge.$fn('securityAudit.getRun').mock.calls.length;

    await act(() => vi.advanceTimersByTimeAsync(4_500));
    expect(bridge.$fn('securityAudit.getRun').mock.calls.length).toBeGreaterThan(callsBefore);

    bridge.$set('securityAudit.listRuns', [summary()]);
    bridge.$set('securityAudit.getRun', detail());
    await act(() => vi.advanceTimersByTimeAsync(4_500));

    await waitFor(() => expect(result.current.live).toBe(false));
    expect(toast.success).toHaveBeenCalledWith(
      'The security audit finished',
      expect.objectContaining({ description: expect.stringMatching(/1 confirmed/) }),
    );

    const settled = bridge.$fn('securityAudit.getRun').mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(12_000));
    expect(bridge.$fn('securityAudit.getRun').mock.calls.length).toBe(settled);
  });

  it('stops tracking a run the user gives up on', async () => {
    const { result } = setup({
      'securityAudit.listRuns': [summary(live)],
      'securityAudit.getRun': detail(live),
    });
    await waitFor(() => expect(result.current.live).toBe(true));

    act(() => result.current.stopTracking('run-1'));

    expect(result.current.live).toBe(false);
    expect(result.current.isDismissed('run-1')).toBe(true);
  });

  it('starts an audit in an agent tab, aimed at a fresh run folder', async () => {
    const { result, bridge } = setup({
      'securityAudit.prepareRun': {
        runName: 'run-3',
        outputDir: '/home/me/security-audit-skill/shop/run-3',
      },
    });
    await waitFor(() => expect(result.current.statusLoading).toBe(false));

    let started = false;
    await act(async () => {
      started = await result.current.startAudit({
        cliId: 'claude-code',
        profile: 'quick',
        scopePaths: ['src'],
      });
    });

    expect(started).toBe(true);
    expect(bridge.$fn('securityAudit.prepareRun')).toHaveBeenCalledWith('p1');
    expect(launch.launchPromptTab).toHaveBeenCalledWith(project, {
      cliId: 'claude-code',
      prompt: expect.stringContaining('/home/me/security-audit-skill/shop/run-3'),
      submit: true,
    });
    expect(result.current.selectedRunName).toBe('run-3');
  });

  it('reports a launch that never opened a tab', async () => {
    launch.launchPromptTab.mockReturnValueOnce(null);
    const { result } = setup({
      'securityAudit.prepareRun': { runName: 'run-1', outputDir: '/x/run-1' },
    });
    await waitFor(() => expect(result.current.statusLoading).toBe(false));

    let started = true;
    await act(async () => {
      started = await result.current.startAudit({
        cliId: 'nope',
        profile: 'standard',
        scopePaths: [],
      });
    });

    expect(started).toBe(false);
  });

  it('installs the skill in a setup tab, records it, and watches for it to land', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const notInstalled = {
      installed: false,
      locations: [],
      node: { found: true, version: 'v22.20.0', meetsMinimum: true },
      runsRoot: '/x',
    };
    const { result, bridge } = setup({ 'securityAudit.status': notInstalled });
    await waitFor(() => expect(result.current.status?.installed).toBe(false));

    act(() => result.current.installSkill(['claude-code', 'codex']));

    expect(launch.launchSetupTab).toHaveBeenCalledWith(
      project,
      'npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit --agent claude-code codex -y',
    );
    await waitFor(() =>
      expect(bridge.$fn('skills.recordSkillsShInstall')).toHaveBeenCalledWith({
        projectId: 'p1',
        owner: 'cloudflare',
        repo: 'cloudflare/security-audit-skill',
        skillName: 'security-audit',
        agents: ['claude-code', 'codex'],
      }),
    );
    expect(result.current.installing).toBe(true);

    bridge.$set('securityAudit.status', {
      ...notInstalled,
      installed: true,
      locations: [{ path: '.claude/skills/security-audit', scope: 'project' }],
    });
    await act(() => vi.advanceTimersByTimeAsync(2_500));

    await waitFor(() => expect(result.current.installing).toBe(false));
    expect(result.current.status?.installed).toBe(true);
  });
});
