import type { ManageTerminal } from '@runova/protocol';
import { agentStatus } from '../../agents/statusTracker';
import { androidSnapshot } from '../../android/runtime';
import { getAndroidSdk } from '../../android/sdk';
import { isDockerAvailable, listContainers } from '../../docker/dockerCli';
import { getErrorTrackingService } from '../../errorTracking/service';
import { readErrorTracking } from '../../errorTracking/store';
import { readGithubAccount } from '../../git/githubAccount';
import { checkHealthNow, listHealthSummaries, setHealthPaused } from '../../ipc/health';
import { sampleSystemStats } from '../../ipc/systemStats';
import {
  createTerminalSession,
  runningSessionIds,
  subscribeTerminalExit,
  subscribeTerminalOutput,
  terminalSessionShell,
  terminalUsage,
  writeToSession,
} from '../../ipc/terminal';
import {
  cancelWorkflowRun,
  dispatchWorkflow,
  fetchJobLog,
  fetchRunDetails,
  fetchWorkflowRefs,
  githubRepoForFolder,
} from '../../pipelines/githubActions';
import { refreshProjectPipelineStatus, schedulePipelineCheck } from '../../pipelines/watcher';
import { keepAwake } from '../../power/keepAwake';
import { getRelayRuntime } from '../../relay/runtime';
import { runningSftpTransfers } from '../../sftp';
import { store } from '../../store';
import { studioService } from '../../studio';
import { onStudioEvent } from '../../studio/host';
import { getAllUsage } from '../../usage';
import { getVaultService } from '../../vault';
import { liveAgents } from './liveAgents';
import { liveDeploy } from './liveDeploy';
import { liveGit } from './liveGit';
import type { ManageMethodDeps } from './methods';

async function listTerminals(): Promise<ManageTerminal[]> {
  const { sessions } = await terminalUsage();
  const tabs = new Map(agentStatus.tabs().map((tab) => [tab.sessionId, tab]));
  return sessions.map((session) => {
    const tab = tabs.get(session.sessionId);
    return {
      sessionId: session.sessionId,
      title: tab?.title ?? session.cliId ?? 'Terminal',
      projectId: tab?.projectId ?? session.projectId ?? null,
      cliId: tab?.cliId ?? session.cliId ?? null,
      status: agentStatus.status(session.sessionId),
      createdAt: session.createdAt,
    };
  });
}

/** Only when an SDK is there, the way the desktop's status bar asks. */
async function androidEmulators(): Promise<{ state: string }[] | null> {
  if ((await getAndroidSdk()).status !== 'found') return null;
  return (await androidSnapshot()).emulators;
}

async function relayRuns() {
  const runtime = getRelayRuntime();
  if (!runtime) return [];
  return (await store.getProjects()).flatMap((project) => runtime.runs(project.id));
}

/** The app's real services, behind the shape the methods are tested against. */
export const liveManageDeps: Omit<ManageMethodDeps, 'forgetPhone'> = {
  listProjects: () => store.getProjects(),
  listTerminals,
  terminalShell: terminalSessionShell,
  attachTerminal: async (sessionId, shell) => {
    const result = await createTerminalSession(
      { sessionId, attachOnly: true, shell: shell as never },
      null,
    );
    return result?.snapshot ?? null;
  },
  onTerminalOutput: subscribeTerminalOutput,
  onTerminalExit: (sessionId, listener) => subscribeTerminalExit(sessionId, () => listener()),
  writeTerminal: writeToSession,
  terminalProcesses: async (sessionId) => {
    const { sessions } = await terminalUsage();
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    return (session?.processes ?? []).map((process) => ({
      name: process.name,
      cpuPercent: process.cpuPercent,
      memBytes: process.memBytes,
    }));
  },
  git: liveGit,
  status: {
    system: sampleSystemStats,
    usage: async () => getAllUsage((await store.getSettings()).usageProviderConfigs ?? {}),
    shownLimits: async () => (await store.getSettings()).statusBarUsage,
    now: Date.now,
    bar: {
      agents: () =>
        agentStatus.tabs().map((tab) => ({
          cliId: tab.cliId,
          status: agentStatus.status(tab.sessionId),
        })),
      terminals: async () => (await runningSessionIds()).length,
      relays: relayRuns,
      transfers: runningSftpTransfers,
      // The account runtime only exists once Anywhere is set up, so that file fills this in.
      sync: async () => null,
      github: readGithubAccount,
      docker: async () => ((await isDockerAvailable()) ? listContainers() : null),
      android: androidEmulators,
      keepAwake: () => keepAwake.status(),
    },
  },
  vault: {
    status: () => getVaultService().status(),
    unlock: (password) => getVaultService().unlock(password),
    lock: () => getVaultService().lock('manual'),
    list: () => getVaultService().list(),
    reveal: (id, field) => getVaultService().reveal(id, field),
    save: (input) => getVaultService().save(input),
    remove: (id) => getVaultService().remove([id]),
  },
  deploy: liveDeploy,
  monitoring: {
    list: () => listHealthSummaries(),
    check: checkHealthNow,
    setPaused: setHealthPaused,
  },
  pipelines: {
    status: refreshProjectPipelineStatus,
    repoOf: async (projectId) => {
      const project = (await store.getProjects()).find((one) => one.id === projectId);
      const repo = project ? await githubRepoForFolder(project.folderPath) : null;
      return repo ? `${repo.owner}/${repo.repo}` : null;
    },
    details: fetchRunDetails,
    jobLog: fetchJobLog,
    refs: fetchWorkflowRefs,
    dispatch: dispatchWorkflow,
    cancel: cancelWorkflowRun,
    afterAction: schedulePipelineCheck,
  },
  studio: { service: studioService, onEvent: onStudioEvent, now: Date.now },
  agents: liveAgents,
  errorTracking: {
    issues: (query) => getErrorTrackingService().listIssues(query),
    linked: async () => (await readErrorTracking()).links.length > 0,
    issue: (ref) => getErrorTrackingService().getIssue(ref),
    setStatus: (change) => getErrorTrackingService().setIssueStatus(change),
    now: Date.now,
  },
};
