import type {
  GithubActionsRunErrorInput,
  GithubActionsRunErrorResult,
} from '../../../shared/apiTypes';
import type { AutoFixSession, AutoFixStartResult } from '../../../shared/ciAutoFixTypes';
import { buildFixRunPrompt } from '../../../shared/pipelineFixPrompt';
import { ManageError, type ManageMethods } from './session';

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
  /** Starts a CLI in the project, on this computer, with the prompt already sent. */
  runPrompt(input: {
    projectId: string;
    prompt: string;
    cliId: string | null;
  }): Promise<{ sessionId: string; title: string }>;
  promptOptions(): Promise<{
    types: readonly string[];
    targets: { id: string; name: string }[];
    defaultTarget: string | null;
  }>;
  generatePrompt(input: {
    rawInput: string;
    promptType: string;
    targetAI: string;
    requestId: string;
  }): Promise<{ ok: boolean; text: string; error?: string; cancelled?: boolean }>;
  cancelPrompt(requestId: string): boolean;
}

const MAX_PROMPT_CHARS = 64 * 1024;
const MAX_ID = 128;

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
export function agentMethods(deps: ManageAgentDeps): ManageMethods['calls'] {
  const project = (params: unknown) => text(params, 'projectId', 'Say which project.');
  const session = (params: unknown) => text(params, 'id', 'Say which auto-fix.');
  async function repository(projectId: string): Promise<string> {
    const repo = await deps.repoOf(projectId);
    if (!repo) throw new ManageError('failed', "This project isn't on GitHub.");
    return repo;
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
      const result = await deps.autoFix.enable({
        projectId,
        repo: await repository(projectId),
        workflowId: count(params, 'workflowId', 'Say which workflow.'),
        workflowName: text(params, 'workflowName', 'Say which workflow.', 256),
        branch: text(params, 'branch', 'Say which branch.', 256),
        runId: optionalCount(params, 'runId'),
        runNumber: optionalCount(params, 'runNumber'),
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
      return deps.runPrompt({
        projectId,
        prompt: buildFixRunPrompt(run, failure.text),
        cliId: null,
      });
    },

    'prompts.options': async () => deps.promptOptions(),

    'prompts.generate': async (params) => {
      const result = await deps.generatePrompt({
        rawInput: text(params, 'rawInput', 'Describe what you want.', MAX_PROMPT_CHARS),
        promptType: text(params, 'promptType', 'Pick a kind of prompt.'),
        targetAI: text(params, 'targetAI', 'Pick who it is for.'),
        requestId: text(params, 'requestId', 'Say which request.'),
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
      deps.runPrompt({
        projectId: project(params),
        prompt: text(params, 'prompt', 'There is no prompt to send.', MAX_PROMPT_CHARS),
        cliId: optionalId(params, 'cliId'),
      }),
  };
}
