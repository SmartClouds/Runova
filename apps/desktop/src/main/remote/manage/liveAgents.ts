import {
  buildPromptGenerationRequest,
  CLI_REGISTRY,
  launchPickOptions,
  PROMPT_TYPES,
  type PromptType,
} from '@runova/core';
import { IPC } from '../../../shared/ipcChannels';
import { agentPickArgs, launchPromptAgent } from '../../agents/promptLaunch';
import { cancelHeadlessPrompt } from '../../cli/headlessPrompt';
import { askCli, runAiPrompt } from '../../ipc/ai';
import { parseStartInput } from '../../ipc/ciAutoFix';
import { createScheduledTasks, updateScheduledTask } from '../../ipc/scheduledTasks';
import { broadcastToWindows } from '../../ipc/send';
import { deleteTemplate, saveTemplate } from '../../ipc/templates';
import { ciAutoFixService } from '../../pipelines/autoFix/wiring';
import { fetchRunFailureText, githubRepoForFolder } from '../../pipelines/githubActions';
import { promptHistoryDb } from '../../promptHistoryDb';
import { store } from '../../store';
import type { ManageAgentDeps } from './agentMethods';

const providerRequests = new Map<string, AbortController>();
const PROVIDER_TIMEOUT_MS = 10 * 60_000;

type GenerateResult = { ok: boolean; text: string; error?: string; cancelled?: boolean };

/** Writes the prompt where Settings says Generate Prompt should go, as the desktop page does. */
async function writePrompt(input: {
  rawInput: string;
  promptType: string;
  targetAI: string;
  requestId: string;
}): Promise<GenerateResult> {
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

function parsedStart(raw: unknown) {
  const input = parseStartInput(raw);
  if (!input) throw new Error('That run could not be followed.');
  return input;
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
  pickArgs: agentPickArgs,
  runPrompt: ({ projectId, prompt, cliId, model, effort }) =>
    launchPromptAgent({ projectId, prompt, cliId, pick: { model, effort }, origin: 'from phone' }),
  promptOptions: async () => {
    const settings = await store.getSettings();
    const fallback = CLI_REGISTRY.find((cli) => cli.id === settings.defaultCliId);
    return {
      types: PROMPT_TYPES,
      targets: CLI_REGISTRY.map((cli) => ({
        id: cli.id,
        name: cli.name,
        // The picker's own data: cliLaunchOptions holds a function, so it can't go on the wire.
        models: (launchPickOptions(cli.id)?.models ?? []).map((model) => ({
          value: model.value,
          label: model.label,
          tier: model.tier ?? null,
          efforts: Object.keys(model.effortCost ?? {}),
        })),
      })),
      defaultTarget: fallback?.name ?? null,
    };
  },
  generatePrompt: async ({ projectId, ...input }) => {
    const result = await writePrompt(input);
    if (result.ok) {
      promptHistoryDb.add({
        rawInput: input.rawInput,
        promptType: input.promptType,
        targetAI: input.targetAI,
        content: result.text,
        source: 'generate',
        projectId,
      });
    }
    return result;
  },
  cancelPrompt: (requestId) => {
    const controller = providerRequests.get(requestId);
    if (controller) {
      controller.abort();
      return true;
    }
    return cancelHeadlessPrompt(requestId);
  },
  templates: () => store.getTemplates(),
  saveTemplate,
  deleteTemplate,
  history: async (query, limit) =>
    query ? promptHistoryDb.search(query, null, limit) : promptHistoryDb.list(null, limit),
  scheduled: () => store.getScheduledTasks(),
  schedule: async ({ projectId, ...task }) => {
    await createScheduledTasks(projectId, [{ ...task, runMode: 'auto' }]);
    broadcastToWindows(IPC.scheduledTasks.onChanged);
  },
  cancelScheduled: async (id) => {
    const updated = await updateScheduledTask(id, { status: 'cancelled' });
    broadcastToWindows(IPC.scheduledTasks.onChanged);
    return updated !== null;
  },
};
