import type { AiProvider, AppSettings } from '@runova/core';

/** The AI provider Settings picked for writing prompts, with that provider's configured model. */
export function promptProviderModel(
  settings: Pick<
    AppSettings,
    'promptBuilderProvider' | 'openaiModel' | 'geminiModel' | 'ollamaModel'
  >,
): { provider: AiProvider; model: string } {
  const provider = settings.promptBuilderProvider;
  const model =
    provider === 'openai'
      ? settings.openaiModel
      : provider === 'gemini'
        ? settings.geminiModel
        : settings.ollamaModel;
  return { provider, model: model ?? '' };
}

type PromptEngineSettings = Pick<
  AppSettings,
  'promptBuilderEngine' | 'promptBuilderProvider' | 'openaiModel' | 'geminiModel' | 'ollamaModel'
>;

/** True when Settings sends Generate Prompt to the default AI CLI instead of an API provider. */
export function promptEngineUsesCli(settings: Pick<AppSettings, 'promptBuilderEngine'>): boolean {
  return settings.promptBuilderEngine === 'cli';
}

/**
 * Why Generate Prompt can't start with these settings, or null when it can. A CLI is only found
 * once the request runs, so only the API provider's missing model is caught up front.
 */
export function promptEngineSetupError(settings: PromptEngineSettings): string | null {
  if (promptEngineUsesCli(settings)) return null;
  const { provider, model } = promptProviderModel(settings);
  return model.trim() ? null : `Set a ${provider} model in Settings first.`;
}

export interface PromptEngineResult {
  ok: boolean;
  text: string;
  error?: string;
  cancelled?: boolean;
}

/**
 * Sends a prompt-writing request where Settings says Generate Prompt should go: the default AI
 * CLI, or the Prompt Builder provider with its model. Cancel a CLI run with ai.cancelAskCli and a
 * provider one with ai.cancel, both by `requestId`.
 */
export async function askPromptEngine(
  settings: PromptEngineSettings,
  prompt: string,
  requestId?: string,
): Promise<PromptEngineResult> {
  if (promptEngineUsesCli(settings)) {
    const result = await window.runova.ai.askCli({ prompt, requestId });
    return {
      ok: result.ok,
      text: result.text,
      error: result.error,
      cancelled: result.cancelled,
    };
  }
  const { provider, model } = promptProviderModel(settings);
  return window.runova.ai.ask({ provider, model, prompt, requestId });
}
