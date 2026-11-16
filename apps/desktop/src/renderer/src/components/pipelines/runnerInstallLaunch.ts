import type {
  RunnerMachineLink,
  SshAgentMode,
  SshAgentProgress,
  SshSavedServer,
} from '@shared/apiTypes';
import { type SshAgentAiChoice, startRunnerInstall } from '@/stores/sshAgentStore';
import { defaultNewSession, useTerminalStore } from '@/stores/terminalStore';

/** Everything the Add runner dialog settled on (E103). */
export interface RunnerInstallRequest {
  where: { kind: 'local' } | { kind: 'ssh'; server: SshSavedServer };
  name: string;
  /** `owner/name`. */
  repo: string;
  mode: SshAgentMode;
  ai: SshAgentAiChoice;
}

/** A run that ended for good, as opposed to one paused on an error the user can continue. */
function endedWithoutFinishing(progress: SshAgentProgress): boolean {
  return progress.phase === 'stopped' || (progress.phase === 'error' && !progress.canContinue);
}

/** Links the new runner to the machine it went on, so its tile shows that machine's figures. */
async function linkRunner(repo: string, name: string, link: RunnerMachineLink): Promise<void> {
  const settings = await window.runova.settings.get();
  // The same key the Runners panel saves a link under: the runner's scope, then its name.
  await window.runova.settings.update({
    runnerMachineLinks: { ...(settings?.runnerMachineLinks ?? {}), [`${repo}/${name}`]: link },
  });
}

/**
 * Opens a terminal tab on the chosen machine and has the AI install the runner there. Resolves
 * with the tab once the task has started. When main refuses (no token, the tab never connected)
 * the tab is closed again and the error comes through. `onInstalled` runs once the AI finishes.
 */
export async function launchRunnerInstall(
  request: RunnerInstallRequest,
  { onInstalled }: { onInstalled: () => void },
): Promise<string> {
  const { where, name, repo } = request;
  const terminal = useTerminalStore.getState();
  const title = `Runner ${name}`;
  const sessionId =
    where.kind === 'ssh'
      ? terminal.openSshSession(where.server, { title })
      : terminal.openSession({ ...defaultNewSession(), title });
  terminal.setActiveSession(sessionId);
  terminal.openDrawer();

  const link: RunnerMachineLink =
    where.kind === 'ssh' ? { kind: 'ssh', serverId: where.server.id } : { kind: 'local' };
  const unsubscribe = window.runova.sshAgent.onProgress((progress) => {
    if (progress.sessionId !== sessionId) return;
    if (progress.phase === 'finished') {
      unsubscribe();
      // A link that fails to save only costs the tile its figures; the runner is installed.
      void linkRunner(repo, name, link)
        .catch(() => undefined)
        .finally(onInstalled);
    } else if (endedWithoutFinishing(progress)) {
      unsubscribe();
    }
  });

  try {
    await startRunnerInstall({
      sessionId,
      target: where.kind,
      name,
      repo,
      mode: request.mode,
      cliId: request.ai.cliId,
      modelId: request.ai.modelId,
      effort: request.ai.effort,
    });
  } catch (error) {
    unsubscribe();
    useTerminalStore.getState().closeSession(sessionId);
    throw error;
  }
  return sessionId;
}
