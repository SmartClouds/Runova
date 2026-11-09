import type { EffortLevel, PromptTemplate, ScheduledTask } from '@runova/core';
import type {
  GithubActionsRunErrorInput,
  GithubActionsRunErrorResult,
  PromptHistoryEntry,
} from '../../../shared/apiTypes';
import type { AutoFixSession, AutoFixStartResult } from '../../../shared/ciAutoFixTypes';
import { buildFixRunPrompt } from '../../../shared/pipelineFixPrompt';
import { ManageError, type ManageMethods } from './session';

export interface AgentModelChoice {
  model: string | null;
  effort: EffortLevel | null;
}

export interface ManageAgentDeps {
  autoFix: {
    list(): AutoFixSession[];
    enable(input: unknown): Promise<AutoFixStartResult>;
    stop(id: string): Promise<AutoFixSession | null>;
    commitNow(id: string): Promise<AutoFixSession | null>;
    retry(id: string): Promise<AutoFixSession | null>;
    dismiss(id: string): Promise<boolean>;
  };
  repoOf(projectId: string): Promise<string | null>;
  failureText(input: GithubActionsRunErrorInput): Promise<GithubActionsRunErrorResult>;
  /** The flags for a model and effort. Throws for a model the CLI doesn't offer. */
  pickArgs(cliId: string, pick: AgentModelChoice): { runArgs: string[]; runLabel: string | null };
  /** Starts a CLI in the project, on this computer, with the prompt already sent. */
  runPrompt(
    input: { projectId: string; prompt: string; cliId: string | null } & AgentModelChoice,
  ): Promise<{ sessionId: string; title: string }>;
  promptOptions(): Promise<{
    types: readonly string[];
    targets: {
      id: string;
      name: string;
      models: { value: string; label: string; tier: string | null; efforts: string[] }[];
    }[];
    defaultTarget: string | null;
  }>;
  generatePrompt(input: {
    rawInput: string;
    promptType: string;
    targetAI: string;
    requestId: string;
    projectId: string | null;
  }): Promise<{ ok: boolean; text: string; error?: string; cancelled?: boolean }>;
  cancelPrompt(requestId: string): boolean;
  templates(): Promise<PromptTemplate[]>;
  saveTemplate(input: {
    name: string;
    promptType: string;
    targetAI: string;
    content: string;
  }): Promise<PromptTemplate>;
  deleteTemplate(id: string): Promise<void>;
  history(query: string | null, limit: number): Promise<PromptHistoryEntry[]>;
  scheduled(): Promise<ScheduledTask[]>;
  schedule(input: {
    projectId: string;
    rawInput: string;
    promptType: string;
    targetAI: string;
    content: string;
    runAt: string;
    cliId?: string;
    model?: string;
    effort?: EffortLevel;
  }): Promise<void>;
  cancelScheduled(id: string): Promise<boolean>;
}

const MAX_PROMPT_CHARS = 64 * 1024;
const MAX_ID = 128;
const MAX_NAME = 200;
const MAX_HISTORY = 30;
const MAX_LISTED = 16 * 1024;
const MAX_SUMMARY = 200;
/** A week: past that it is a calendar's job. */
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

function text(params: unknown, name: string, say: string, limit = MAX_ID): string {
  const value = field(params, name);
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) {
    throw new ManageError('bad-params', say);
  }
  return value;
}

function count(params: unknown, name: string, say: string): number {
  const value = field(params, name);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ManageError('bad-params', say);
  }
  return value;
}

function optionalCount(params: unknown, name: string): number | undefined {
  return field(params, name) === undefined || field(params, name) === null
    ? undefined
    : count(params, name, 'That run is not valid.');
}

function optionalId(params: unknown, name: string): string | null {
  const value = field(params, name);
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_ID) {
    throw new ManageError('bad-params', `That ${name} is not valid.`);
  }
  return value;
}

function choiceOf(params: unknown): AgentModelChoice {
  const model = optionalId(params, 'model');
  const effort = optionalId(params, 'effort');
  if (effort !== null && !EFFORTS.includes(effort)) {
    throw new ManageError('bad-params', 'That effort is not offered.');
  }
  return { model, effort: effort as EffortLevel | null };
}

function shorten(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** What the phone shows of a session: no folders, flags or tab details. */
function sessionOf(session: AutoFixSession) {
  const last = session.attempts[session.attempts.length - 1];
  return {
    id: session.id,
    projectId: session.projectId,
    workflowId: session.workflowId,
    workflowName: session.workflowName,
    branch: session.branch,
    phase: session.phase,
    blocker: session.blocker,
    message: session.message,
    maxAttempts: session.maxAttempts,
    runNumber: session.runNumber,
    agentSession: session.phase === 'fixing' ? (last?.tabId ?? null) : null,
    attempts: session.attempts.map((attempt) => ({
      n: attempt.n,
      runNumber: attempt.runNumber,
      nextRunNumber: attempt.nextRunNumber,
      commit: attempt.commitSha?.slice(0, 7) ?? null,
      outcome: attempt.outcome,
    })),
  };
}

function changed(session: AutoFixSession | null, done: string) {
  return session
    ? { ok: true, message: done }
    : { ok: false, message: 'That auto-fix is not there any more.' };
}

/** Starting agents from the phone. They run on the computer; the phone watches their terminal. */
export function agentMethods(
  deps: ManageAgentDeps,
  now: () => number = Date.now,
): ManageMethods['calls'] {
  const project = (params: unknown) => text(params, 'projectId', 'Say which project.');
  const session = (params: unknown) => text(params, 'id', 'Say which auto-fix.');
  async function repository(projectId: string): Promise<string> {
    const repo = await deps.repoOf(projectId);
    if (!repo) throw new ManageError('failed', "This project isn't on GitHub.");
    return repo;
  }
  /** Turns a refusal from the computer, like a model it doesn't offer, into words for the phone. */
  function agent<T>(start: () => T): T {
    try {
      return start();
    } catch (error) {
      if (error instanceof ManageError) throw error;
      throw new ManageError('failed', error instanceof Error ? error.message : String(error));
    }
  }

  return {
    'autofix.list': async (params) => {
      const projectId = project(params);
      return deps.autoFix
        .list()
        .filter((one) => one.projectId === projectId)
        .map(sessionOf);
    },

    'autofix.start': async (params) => {
      const projectId = project(params);
      const cliId = optionalId(params, 'cliId');
      const flags = cliId ? agent(() => deps.pickArgs(cliId, choiceOf(params))) : null;
      const result = await deps.autoFix.enable({
        projectId,
        repo: await repository(projectId),
        workflowId: count(params, 'workflowId', 'Say which workflow.'),
        workflowName: text(params, 'workflowName', 'Say which workflow.', 256),
        branch: text(params, 'branch', 'Say which branch.', 256),
        runId: optionalCount(params, 'runId'),
        runNumber: optionalCount(params, 'runNumber'),
        ...(cliId && flags ? { cliId, runArgs: flags.runArgs, runLabel: flags.runLabel } : {}),
      });
      return result.ok
        ? { ok: true, message: 'Auto-fix is on.' }
        : { ok: false, message: result.error };
    },

    'autofix.stop': async (params) => changed(await deps.autoFix.stop(session(params)), 'Stopped.'),
    'autofix.retry': async (params) =>
      changed(await deps.autoFix.retry(session(params)), 'Trying again.'),
    'autofix.commitNow': async (params) =>
      changed(await deps.autoFix.commitNow(session(params)), 'Committing the fix.'),
    'autofix.dismiss': async (params) => {
      const removed = await deps.autoFix.dismiss(session(params));
      return removed
        ? { ok: true, message: '' }
        : { ok: false, message: "It's still running, so it can't be cleared yet." };
    },

    'agents.fixRun': async (params) => {
      const projectId = project(params);
      const run: GithubActionsRunErrorInput = {
        repo: await repository(projectId),
        runId: count(params, 'runId', 'Say which run.'),
        workflowName: text(params, 'workflowName', 'Say which workflow.', 256),
        runNumber: optionalCount(params, 'runNumber'),
        headBranch: text(params, 'branch', 'Say which branch.', 256),
      };
      const failure = await deps.failureText(run);
      if (!failure.ok) throw new ManageError('failed', failure.error);
      return agent(() =>
        deps.runPrompt({
          projectId,
          prompt: buildFixRunPrompt(run, failure.text),
          cliId: optionalId(params, 'cliId'),
          ...choiceOf(params),
        }),
      );
    },

    'prompts.options': async () => deps.promptOptions(),

    'prompts.generate': async (params) => {
      const result = await deps.generatePrompt({
        rawInput: text(params, 'rawInput', 'Describe what you want.', MAX_PROMPT_CHARS),
        promptType: text(params, 'promptType', 'Pick a kind of prompt.'),
        targetAI: text(params, 'targetAI', 'Pick who it is for.'),
        requestId: text(params, 'requestId', 'Say which request.'),
        projectId: optionalId(params, 'projectId'),
      });
      return {
        ok: result.ok,
        text: result.text,
        error: result.error ?? null,
        cancelled: result.cancelled === true,
      };
    },

    'prompts.cancel': async (params) => ({
      cancelled: deps.cancelPrompt(text(params, 'requestId', 'Say which request.')),
    }),

    'agents.runPrompt': async (params) =>
      agent(() =>
        deps.runPrompt({
          projectId: project(params),
          prompt: text(params, 'prompt', 'There is no prompt to send.', MAX_PROMPT_CHARS),
          cliId: optionalId(params, 'cliId'),
          ...choiceOf(params),
        }),
      ),

    'prompts.templates': async () =>
      (await deps.templates()).map(({ id, name, promptType, targetAI, content }) => ({
        id,
        name,
        promptType,
        targetAI,
        content,
      })),

    'prompts.saveTemplate': async (params) => {
      await deps.saveTemplate({
        name: text(params, 'name', 'Name the template.', MAX_NAME),
        promptType: text(params, 'promptType', 'Pick a kind of prompt.'),
        targetAI: text(params, 'targetAI', 'Pick who it is for.'),
        content: text(params, 'content', 'There is no prompt to save.', MAX_PROMPT_CHARS),
      });
      return { ok: true, message: 'Template saved.' };
    },

    'prompts.deleteTemplate': async (params) => {
      await deps.deleteTemplate(text(params, 'id', 'Say which template.'));
      return { ok: true, message: 'Template deleted.' };
    },

    'prompts.history': async (params) => {
      const query = optionalId(params, 'query');
      const current = now();
      return (await deps.history(query, MAX_HISTORY)).map((entry) => ({
        id: entry.id,
        rawInput: shorten(entry.rawInput, MAX_SUMMARY),
        promptType: entry.promptType,
        targetAI: entry.targetAI,
        content: shorten(entry.content, MAX_LISTED),
        agoMs: current - Date.parse(entry.createdAt),
      }));
    },

    'prompts.scheduled': async (params) => {
      const projectId = project(params);
      const current = now();
      return (await deps.scheduled())
        .filter((task) => task.projectId === projectId && task.status === 'pending')
        .map((task) => ({
          id: task.id,
          summary: shorten(task.rawInput || task.content, MAX_SUMMARY),
          targetAI: task.targetAI,
          runsInMs: Date.parse(task.runAt) - current,
        }));
    },

    'prompts.schedule': async (params) => {
      const inMs = count(params, 'inMs', 'Say when.');
      if (inMs > MAX_DELAY_MS) throw new ManageError('bad-params', 'That is too far ahead.');
      const cliId = optionalId(params, 'cliId');
      const { model, effort } = choiceOf(params);
      if (cliId) agent(() => deps.pickArgs(cliId, { model, effort }));
      await deps.schedule({
        projectId: project(params),
        rawInput: text(params, 'rawInput', 'Describe what you want.', MAX_PROMPT_CHARS),
        promptType: text(params, 'promptType', 'Pick a kind of prompt.'),
        targetAI: text(params, 'targetAI', 'Pick who it is for.'),
        content: text(params, 'content', 'There is no prompt to schedule.', MAX_PROMPT_CHARS),
        // The computer's clock, because a phone's can be wrong.
        runAt: new Date(now() + inMs).toISOString(),
        ...(cliId ? { cliId } : {}),
        ...(cliId && model ? { model } : {}),
        ...(cliId && effort ? { effort } : {}),
      });
      return { ok: true, message: 'Scheduled.' };
    },

    'prompts.cancelScheduled': async (params) => {
      const cancelled = await deps.cancelScheduled(text(params, 'id', 'Say which task.'));
      return cancelled
        ? { ok: true, message: 'Cancelled.' }
        : { ok: false, message: 'That task is not there any more.' };
    },
  };
}
