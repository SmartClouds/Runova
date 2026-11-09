import { randomUUID } from 'node:crypto';
import {
  buildAgentLaunchCommand,
  cliIdForTargetAI,
  type EffortLevel,
  getCliDefinition,
  launchPickArgs,
  launchPickLabel,
  launchPickOptions,
  type ScheduledTask,
  shellKindFor,
} from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import {
  createTerminalSession,
  defaultTerminalShell,
  subscribeTerminalOutput,
  writeToShell,
} from '../ipc/terminal';
import { showOsNotification } from '../notifications/osNotification';
import { deliverWhenReady } from '../relay/delivery';
import { store } from '../store';
import { claudeHookSettingsPath, supportsStatusHooks } from './claudeHooks';
import { agentStatus } from './statusTracker';

export interface AgentPick {
  model?: string | null;
  effort?: EffortLevel | null;
}

/**
 * The launch flags and label for a model and effort. The model has to be one the CLI offers, so
 * nothing else can end up on its command line.
 */
export function agentPickArgs(
  cliId: string,
  pick: AgentPick,
): { runArgs: string[]; runLabel: string | null } {
  const model = pick.model ?? undefined;
  if (model && !launchPickOptions(cliId)?.models.some((one) => one.value === model)) {
    throw new Error('That model is not offered for this CLI.');
  }
  const choice = { model, effort: pick.effort ?? undefined };
  return {
    runArgs: launchPickArgs(cliId, choice),
    runLabel: launchPickLabel(cliId, choice) ?? null,
  };
}

/** A CLI in the project, in its normal mode, with the prompt sent, and a tab on the desktop. */
export async function launchPromptAgent(input: {
  projectId: string;
  prompt: string;
  cliId: string | null;
  pick?: AgentPick;
  origin: string;
}): Promise<{ sessionId: string; title: string }> {
  const [projects, settings] = await Promise.all([store.getProjects(), store.getSettings()]);
  const project = projects.find((one) => one.id === input.projectId);
  if (!project) throw new Error('That project is not on this computer.');
  const cliId = input.cliId ?? project.cliId ?? settings.defaultCliId;
  const cli = cliId ? getCliDefinition(cliId) : undefined;
  if (!cliId || !cli) throw new Error('Pick an AI CLI in Runova on this computer first.');
  const { runArgs, runLabel } = agentPickArgs(cliId, input.pick ?? {});
  const shell = defaultTerminalShell();
  const hookSettingsPath = supportsStatusHooks(cliId) ? await claudeHookSettingsPath() : null;
  const command = buildAgentLaunchCommand({
    cliId,
    shellKind: shellKindFor(shell, process.platform),
    hookSettingsPath,
    launchDefaults: settings.cliLaunchDefaults?.[cliId],
    runArgs,
  });
  if (!command) throw new Error(`${cli.name} has no launch command.`);

  const sessionId = randomUUID();
  const title = `${cli.name} · ${input.origin}`;
  agentStatus.pin({ sessionId, projectId: project.id, cliId, title });
  const created = await createTerminalSession(
    {
      sessionId,
      shell,
      cwd: project.folderPath,
      initialInput: `${command}\r`,
      projectId: project.id,
      cliId,
      surface: 'workspace',
    },
    null,
  ).catch((error: unknown) => {
    agentStatus.unpin(sessionId);
    throw error;
  });
  if (!created) {
    agentStatus.unpin(sessionId);
    throw new Error('The terminal could not start.');
  }
  void deliverWhenReady(input.prompt, {
    subscribe: (listener) => subscribeTerminalOutput(sessionId, listener),
    write: (data) => writeToShell(sessionId, data),
  });
  broadcastToWindows(IPC.ciAutoFix.onTab, {
    projectId: project.id,
    tabId: sessionId,
    sessionId,
    cliId,
    title,
    ...(runLabel ? { runLabel } : {}),
    cwd: project.folderPath,
  });
  return { sessionId, title };
}

/** Starts a due task when there is no window to hand it to. A failure can only be a notification. */
export async function launchScheduledTask(task: ScheduledTask): Promise<void> {
  const settings = await store.getSettings();
  const cliId = [task.cliId, settings.defaultCliId, cliIdForTargetAI(task.targetAI)].find(
    (id): id is string => Boolean(id && getCliDefinition(id)),
  );
  try {
    await launchPromptAgent({
      projectId: task.projectId,
      prompt: task.content,
      cliId: cliId ?? null,
      // Model and effort only make sense for the CLI they were picked for.
      pick: task.cliId === cliId ? { model: task.model, effort: task.effort } : {},
      origin: 'scheduled',
    });
  } catch (error) {
    showOsNotification({
      title: 'A scheduled prompt could not start',
      body: error instanceof Error ? error.message : String(error),
      route: `/workspace/${task.projectId}`,
    });
  }
}
