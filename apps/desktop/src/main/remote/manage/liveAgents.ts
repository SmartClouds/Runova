import { randomUUID } from 'node:crypto';
import {
  buildAgentLaunchCommand,
  buildPromptGenerationRequest,
  CLI_REGISTRY,
  getCliDefinition,
  PROMPT_TYPES,
  type PromptType,
  shellKindFor,
} from '@runova/core';
import { IPC } from '../../../shared/ipcChannels';
import { claudeHookSettingsPath, supportsStatusHooks } from '../../agents/claudeHooks';
import { agentStatus } from '../../agents/statusTracker';
import { cancelHeadlessPrompt } from '../../cli/headlessPrompt';
import { askCli, runAiPrompt } from '../../ipc/ai';
import { parseStartInput } from '../../ipc/ciAutoFix';
import { broadcastToWindows } from '../../ipc/send';
import {
  createTerminalSession,
  defaultTerminalShell,
  subscribeTerminalOutput,
  writeToShell,
} from '../../ipc/terminal';
import { ciAutoFixService } from '../../pipelines/autoFix/wiring';
import { fetchRunFailureText, githubRepoForFolder } from '../../pipelines/githubActions';
import { deliverWhenReady } from '../../relay/delivery';
import { store } from '../../store';
import type { ManageAgentDeps } from './agentMethods';

/** A CLI in the project, in its normal mode, shown as a tab on the desktop as well. */
async function runPrompt(input: {
  projectId: string;
  prompt: string;
  cliId: string | null;
}): Promise<{ sessionId: string; title: string }> {
  const [projects, settings] = await Promise.all([store.getProjects(), store.getSettings()]);
  const project = projects.find((one) => one.id === input.projectId);
  if (!project) throw new Error('That project is not on this computer.');
  const cliId = input.cliId ?? project.cliId ?? settings.defaultCliId;
  const cli = cliId ? getCliDefinition(cliId) : undefined;
  if (!cliId || !cli) throw new Error('Pick an AI CLI in Runova on this computer first.');
  const shell = defaultTerminalShell();
  const hooks = supportsStatusHooks(cliId);
  const hookSettingsPath = hooks ? await claudeHookSettingsPath() : null;
  const command = buildAgentLaunchCommand({
    cliId,
    shellKind: shellKindFor(shell, process.platform),
    hookSettingsPath,
    launchDefaults: settings.cliLaunchDefaults?.[cliId],
    runArgs: [],
  });
  if (!command) throw new Error(`${cli.name} has no launch command.`);

  const sessionId = randomUUID();
  const title = `${cli.name} · from phone`;
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
    cwd: project.folderPath,
  });
  return { sessionId, title };
}

const providerRequests = new Map<string, AbortController>();
const PROVIDER_TIMEOUT_MS = 10 * 60_000;

/** Writes the prompt where Settings says Generate Prompt should go, as the desktop page does. */
async function generatePrompt(input: {
  rawInput: string;
  promptType: string;
  targetAI: string;
  requestId: string;
}) {
  if (!PROMPT_TYPES.includes(input.promptType as PromptType)) {
    return { ok: false, text: '', error: 'That kind of prompt is not offered.' };
  }
  const settings = await store.getSettings();
  const prompt = buildPromptGenerationRequest({
    rawInput: input.rawInput,
    promptType: input.promptType as PromptType,
    targetAI: input.targetAI,
  });
  if (settings.promptBuilderEngine === 'cli') {
    const result = await askCli({ prompt, requestId: input.requestId });
    return {
      ok: result.ok,
      text: result.text.trim(),
      error: result.error,
      cancelled: result.cancelled,
    };
  }
  const provider = settings.promptBuilderProvider;
  const model =
    provider === 'openai'
      ? settings.openaiModel
      : provider === 'gemini'
        ? settings.geminiModel
        : settings.ollamaModel;
  if (!model?.trim()) {
    return { ok: false, text: '', error: `Set a ${provider} model in Settings first.` };
  }
  const controller = new AbortController();
  providerRequests.set(input.requestId, controller);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
    const text = await runAiPrompt(provider, model, prompt, [], signal);
    return { ok: true, text: text.trim() };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, text: '', cancelled: true };
    return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    providerRequests.delete(input.requestId);
  }
}

export const liveAgents: ManageAgentDeps = {
  autoFix: {
    list: () => ciAutoFixService().list(),
    enable: (input) => ciAutoFixService().enable(parsedStart(input)),
    stop: (id) => ciAutoFixService().stop(id),
    commitNow: (id) => ciAutoFixService().commitNow(id),
    retry: (id) => ciAutoFixService().retry(id),
    dismiss: (id) => ciAutoFixService().dismiss(id),
  },
  repoOf: async (projectId) => {
    const project = (await store.getProjects()).find((one) => one.id === projectId);
    const repo = project ? await githubRepoForFolder(project.folderPath) : null;
    return repo ? `${repo.owner}/${repo.repo}` : null;
  },
  failureText: fetchRunFailureText,
  runPrompt,
  promptOptions: async () => {
    const settings = await store.getSettings();
    const fallback = CLI_REGISTRY.find((cli) => cli.id === settings.defaultCliId);
    return {
      types: PROMPT_TYPES,
      targets: CLI_REGISTRY.map((cli) => ({ id: cli.id, name: cli.name })),
      defaultTarget: fallback?.name ?? null,
    };
  },
  generatePrompt,
  cancelPrompt: (requestId) => {
    const controller = providerRequests.get(requestId);
    if (controller) {
      controller.abort();
      return true;
    }
    return cancelHeadlessPrompt(requestId);
  },
};

function parsedStart(raw: unknown) {
  const input = parseStartInput(raw);
  if (!input) throw new Error('That run could not be followed.');
  return input;
}
