import {
  cliIdForTargetAI,
  type EffortLevel,
  getCliDefinition,
  launchDefaultArgs,
  type Project,
} from '@runova/core';
import { launchPromptTab } from '@/lib/workspace/launch';
import { useCliStore } from '@/stores/cliStore';

export interface PromptRun {
  content: string;
  targetAI: string;
  cliId?: string;
  model?: string;
  effort?: EffortLevel;
  /**
   * Press Enter once the prompt is in. Off for the Run button, where the user reads the prompt
   * over in the CLI and starts it themselves. On for a scheduled prompt that came due on its own.
   */
  submit: boolean;
}

export interface StartedPromptRun {
  cliName: string;
  tabId: string;
}

/** The task's own CLI, then the app default, then whichever CLI its target AI belongs to. */
export function resolveRunCliId(cliId: string | undefined, targetAI: string): string | null {
  const candidates = [cliId, useCliStore.getState().defaultCliId, cliIdForTargetAI(targetAI)];
  return candidates.find((id): id is string => Boolean(id && getCliDefinition(id))) ?? null;
}

/**
 * Opens an agent tab in the project's workspace that starts the CLI with the task's model and
 * effort, and pastes the prompt into it once the CLI is ready. Returns null when there's no CLI
 * to run it in.
 */
export function runPromptInWorkspace(project: Project, run: PromptRun): StartedPromptRun | null {
  const cliId = resolveRunCliId(run.cliId, run.targetAI);
  const cli = cliId ? getCliDefinition(cliId) : undefined;
  if (!cliId || !cli) return null;

  // Model and effort only make sense for the CLI they were picked for.
  const runArgs =
    run.cliId === cliId ? launchDefaultArgs(cliId, { model: run.model, effort: run.effort }) : [];
  const tabId = launchPromptTab(project, {
    cliId,
    prompt: run.content,
    runArgs,
    runLabel: 'Scheduled prompt',
    submit: run.submit,
  });
  return tabId ? { cliName: cli.name, tabId } : null;
}
