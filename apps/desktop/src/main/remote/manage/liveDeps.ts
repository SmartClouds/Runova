import type { ManageTerminal } from '@runova/protocol';
import { agentStatus } from '../../agents/statusTracker';
import { sampleSystemStats } from '../../ipc/systemStats';
import {
  createTerminalSession,
  subscribeTerminalExit,
  subscribeTerminalOutput,
  terminalSessionShell,
  terminalUsage,
  writeToSession,
} from '../../ipc/terminal';
import { store } from '../../store';
import { getAllUsage } from '../../usage';
import { getVaultService } from '../../vault';
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

/** The app's real services, behind the shape the methods are tested against. */
export const liveManageDeps: ManageMethodDeps = {
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
};
