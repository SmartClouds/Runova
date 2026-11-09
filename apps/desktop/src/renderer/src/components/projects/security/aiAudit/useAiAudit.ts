import type { AiAuditPhase, AiAuditProfile, AiAuditRunDetail, Project } from '@runova/core';
import {
  buildSecurityAuditInstallCommand,
  buildSecurityAuditPrompt,
  SECURITY_AUDIT_REPO_URL,
  SECURITY_AUDIT_SKILL_NAME,
} from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useProjectUiState } from '@/hooks/useProjectUiState';
import { queryKeys } from '@/lib/queryKeys';
import { useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { launchPromptTab, launchSetupTab, startTabNow } from '@/lib/workspace/launch';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/**
 * The AI security audit's data layer. The agent does the audit in a workspace tab and writes a
 * run folder; this hook finds that run, keeps it fresh while the agent works, and stops polling
 * once the run says it has ended (or the user stops tracking it).
 */

const QUIET = { meta: { silentLoading: true } } as const;
/** How often a running audit is re-read. The agent writes a file every few minutes at most. */
const LIVE_POLL_MS = 4_000;
/** How often the install status is re-read while the install tab is working. */
const INSTALL_POLL_MS = 2_000;

/** `cloudflare/security-audit-skill`, the form the Skills page records installs under. */
const SKILL_REPO = SECURITY_AUDIT_REPO_URL.replace('https://github.com/', '');

function isLivePhase(phase: AiAuditPhase | undefined): boolean {
  return phase !== undefined && phase !== 'complete' && phase !== 'incomplete';
}

function finishedToast(run: AiAuditRunDetail): void {
  if (run.phase === 'incomplete') {
    toast.warning('The security audit stopped early', {
      description: run.metadata?.incompleteReason ?? 'The report says what it could not finish.',
    });
    return;
  }
  const confirmed = run.counts?.confirmed ?? 0;
  const pending = run.counts?.needsValidation ?? 0;
  toast.success('The security audit finished', {
    description: `${confirmed} confirmed finding${confirmed === 1 ? '' : 's'}, ${pending} to validate.`,
  });
}

export interface StartAuditInput {
  cliId: string;
  profile: AiAuditProfile;
  scopePaths: string[];
  /** Model and effort flags for the agent. Left out, it runs on its own defaults. */
  runArgs?: string[];
  /** Shown on the agent's tab, e.g. "Opus 5.5 · High". */
  runLabel?: string;
}

export function useAiAudit(project: Project) {
  const projectId = project.id;
  const queryClient = useQueryClient();
  // The Setup tab running the install, for as long as the wizard is waiting on it.
  const [installTabId, setInstallTabId] = useState<string | null>(null);
  const installing = installTabId !== null;
  const [pickedRun, setPickedRun] = useProjectUiState<string | null>('security.audit.run', null);
  const [dismissed, setDismissed] = useProjectUiState<string[]>('security.audit.dismissed', []);
  // Which workspace tab each run's agent was started in, so Stop can end that agent.
  const [agentTabs, setAgentTabs] = useProjectUiState<Record<string, string>>(
    'security.audit.agentTabs',
    {},
  );

  const statusQuery = useQuery({
    queryKey: queryKeys.aiAuditStatus(projectId),
    queryFn: () => window.runova.securityAudit.status(projectId),
    refetchInterval: installing ? INSTALL_POLL_MS : false,
    ...QUIET,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.aiAuditRuns(projectId),
    queryFn: () => window.runova.securityAudit.listRuns(projectId),
    ...QUIET,
  });
  const runs = runsQuery.data ?? [];

  // The run the user picked, or the newest one. A picked run that has since been deleted falls
  // back to the newest too.
  const selectedRunName =
    (pickedRun && runs.some((run) => run.runName === pickedRun) ? pickedRun : null) ??
    runs[0]?.runName ??
    pickedRun;
  const selectedSummary = runs.find((run) => run.runName === selectedRunName) ?? null;

  const runQuery = useQuery({
    queryKey: queryKeys.aiAuditRun(projectId, selectedRunName ?? ''),
    queryFn: () => window.runova.securityAudit.getRun(projectId, selectedRunName as string),
    enabled: selectedRunName !== null && selectedSummary !== null,
    refetchInterval: (query) =>
      selectedRunName &&
      !dismissed.includes(selectedRunName) &&
      isLivePhase(query.state.data?.phase ?? selectedSummary?.phase)
        ? LIVE_POLL_MS
        : false,
    ...QUIET,
  });
  const run = runQuery.data?.runName === selectedRunName ? runQuery.data : null;
  const phase = run?.phase ?? selectedSummary?.phase;
  const live =
    selectedRunName !== null && !dismissed.includes(selectedRunName) && isLivePhase(phase);

  const selectedTabId = selectedRunName ? agentTabs[selectedRunName] : undefined;
  const selectedTabOpen = useWorkspaceStore((s) =>
    selectedTabId ? Boolean(s.workspaces[projectId]?.tabs[selectedTabId]) : false,
  );
  // 'unknown' is a run started before tabs were recorded, or whose record has been lost.
  const agentTab: 'open' | 'closed' | 'unknown' = !selectedTabId
    ? 'unknown'
    : selectedTabOpen
      ? 'open'
      : 'closed';

  // The run list carries each run's phase too, so it follows the detail while a run is live.
  useEffect(() => {
    if (run && selectedSummary && run.phase !== selectedSummary.phase) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiAuditRuns(projectId) });
    }
  }, [run, selectedSummary, projectId, queryClient]);

  // Said once, when a run this tab watched goes from working to ended.
  const watched = useRef<{ runName: string; live: boolean } | null>(null);
  useEffect(() => {
    if (!run) return;
    const before = watched.current;
    watched.current = { runName: run.runName, live: isLivePhase(run.phase) };
    if (before?.runName === run.runName && before.live && !isLivePhase(run.phase)) {
      finishedToast(run);
    }
  }, [run]);

  // The install tab writes the skill's folder; once it is there, the wizard can move on.
  useEffect(() => {
    if (installing && statusQuery.data?.installed) {
      setInstallTabId(null);
      toast.success('The security audit skill is installed in this project.');
    }
  }, [installing, statusQuery.data?.installed]);

  // A tab that closed or a shell that ended will never finish the install, so stop waiting on it.
  // A failed command leaves its shell open at the prompt, which is what Cancel is for.
  const installTabGone = useWorkspaceStore(
    (s) => installTabId !== null && !s.workspaces[projectId]?.tabs[installTabId],
  );
  const installShellEnded = useTerminalSessionStore(
    (s) => installTabId !== null && installTabId in s.ended,
  );
  const installOver = installTabGone || installShellEnded;
  const { refetch: refetchStatus } = statusQuery;
  useEffect(() => {
    if (!installTabId || !installOver) return;
    let superseded = false;
    void refetchStatus().then(({ data }) => {
      // A skill that landed is reported by the effect above.
      if (superseded || data?.installed) return;
      setInstallTabId(null);
      toast.error('The install ended before the skill was in place', {
        description: 'Run it again and open the terminal output to see what happens.',
      });
    });
    return () => {
      superseded = true;
    };
  }, [installTabId, installOver, refetchStatus]);

  const installSkill = useCallback(
    (agents: string[]) => {
      const command = buildSecurityAuditInstallCommand(agents);
      const tabId = launchSetupTab(project, command);
      // The wizard sits on another page, so no pane may be there to show the tab and start it.
      startTabNow(project.id, tabId);
      setInstallTabId(tabId);
      // Recorded like any skills.sh install, so the Skills page lists it for this project.
      void window.runova.skills
        .recordSkillsShInstall({
          projectId,
          owner: 'cloudflare',
          repo: SKILL_REPO,
          skillName: SECURITY_AUDIT_SKILL_NAME,
          agents,
        })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: queryKeys.installedSkills(projectId) }),
        )
        .catch(() => {
          // Only Runova's own bookkeeping; the install itself runs in the tab regardless.
        });
    },
    [project, projectId, queryClient],
  );

  const cancelInstall = useCallback(() => {
    setInstallTabId(null);
    if (installTabId) useWorkspaceStore.getState().closeTab(projectId, installTabId);
  }, [installTabId, projectId]);

  const startAudit = useCallback(
    async (input: StartAuditInput): Promise<boolean> => {
      let prepared: { runName: string; outputDir: string };
      try {
        prepared = await window.runova.securityAudit.prepareRun(projectId);
      } catch (error) {
        toast.error(
          `Could not create the run folder: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
      const prompt = buildSecurityAuditPrompt({
        outputDir: prepared.outputDir,
        profile: input.profile,
        scopePaths: input.scopePaths,
      });
      const tabId = launchPromptTab(project, {
        cliId: input.cliId,
        prompt,
        submit: true,
        runArgs: input.runArgs,
        runLabel: input.runLabel,
      });
      if (!tabId) return false;
      startTabNow(project.id, tabId);
      setPickedRun(prepared.runName);
      setAgentTabs((current) => ({ ...current, [prepared.runName]: tabId }));
      setDismissed((current) => current.filter((name) => name !== prepared.runName));
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiAuditRuns(projectId) });
      return true;
    },
    [project, projectId, queryClient, setPickedRun, setDismissed, setAgentTabs],
  );

  /** Ends the run's agent, along with everything it started, and stops following the run. */
  const stopAudit = useCallback(
    (runName: string) => {
      const tabId = agentTabs[runName];
      const store = useWorkspaceStore.getState();
      if (tabId && store.workspaces[projectId]?.tabs[tabId]) store.closeTab(projectId, tabId);
      setDismissed((current) => (current.includes(runName) ? current : [...current, runName]));
    },
    [agentTabs, projectId, setDismissed],
  );

  const keepTracking = useCallback(
    (runName: string) => setDismissed((current) => current.filter((name) => name !== runName)),
    [setDismissed],
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.aiAuditStatus(projectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.aiAuditRuns(projectId) }),
      selectedRunName
        ? queryClient.invalidateQueries({
            queryKey: queryKeys.aiAuditRun(projectId, selectedRunName),
          })
        : Promise.resolve(),
    ]);
  }, [projectId, queryClient, selectedRunName]);

  return {
    status: statusQuery.data ?? null,
    statusLoading: statusQuery.isPending,
    statusError: statusQuery.error
      ? statusQuery.error instanceof Error
        ? statusQuery.error.message
        : String(statusQuery.error)
      : null,
    runs,
    runsLoading: runsQuery.isPending,
    selectedRunName,
    selectRun: setPickedRun,
    selectedSummary,
    run,
    runLoading: runQuery.isPending && selectedSummary !== null,
    live,
    isDismissed: (runName: string) => dismissed.includes(runName),
    /** Whether Runova knows which tab this run's agent was started in. */
    hasAgentTab: (runName: string) => runName in agentTabs,
    agentTab,
    stopAudit,
    keepTracking,
    installing,
    installTabId,
    installSkill,
    cancelInstall,
    startAudit,
    refresh,
  };
}

export type AiAuditState = ReturnType<typeof useAiAudit>;
