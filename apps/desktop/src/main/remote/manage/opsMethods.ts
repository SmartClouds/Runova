import type { ErrorEvent, ErrorFrame } from '@runova/core';
import type {
  ManageErrorDetail,
  ManageErrorIssue,
  ManageErrorList,
  ManageJobLog,
  ManageLocalMonitor,
  ManagePipelineRun,
  ManagePipelineStatus,
} from '@runova/protocol';
import type {
  GithubJobLogInput,
  GithubJobLogResult,
  GithubPipelineActionResult,
  GithubRunCancelRequest,
  GithubRunDetailsResult,
  GithubWorkflowDispatchRequest,
  GithubWorkflowRefsResult,
  GithubWorkflowRunInfo,
  ProjectPipelineStatus,
} from '../../../shared/apiTypes';
import type {
  ErrorIssueDetail,
  ErrorIssuePage,
  ErrorIssueQuery,
  ErrorIssueRef,
  ErrorIssueSummary,
  ErrorStatusChange,
} from '../../../shared/errorTrackingTypes';
import type { HealthTargetSummary } from '../../../shared/healthTypes';
import { ManageError, type ManageMethods } from './session';

export interface ManageMonitoringDeps {
  list(): Promise<HealthTargetSummary[]>;
  check(id: string): Promise<unknown>;
  setPaused(id: string, paused: boolean): Promise<unknown>;
}

export interface ManagePipelineDeps {
  status(projectId: string): Promise<ProjectPipelineStatus>;
  /** `owner/repo` for a project, or null when it is not on GitHub. */
  repoOf(projectId: string): Promise<string | null>;
  details(input: { repo: string; runId: number }): Promise<GithubRunDetailsResult>;
  jobLog(input: GithubJobLogInput): Promise<GithubJobLogResult>;
  refs(repo: string): Promise<GithubWorkflowRefsResult>;
  dispatch(input: GithubWorkflowDispatchRequest): Promise<GithubPipelineActionResult>;
  cancel(input: GithubRunCancelRequest): Promise<GithubPipelineActionResult>;
  afterAction(projectId: string): void;
}

export interface ManageErrorTrackingDeps {
  issues(query: ErrorIssueQuery): Promise<ErrorIssuePage>;
  /** Whether any provider project is linked to a project on this computer. */
  linked(): Promise<boolean>;
  issue(ref: ErrorIssueRef): Promise<ErrorIssueDetail>;
  setStatus(change: ErrorStatusChange): Promise<ErrorIssueSummary>;
  now(): number;
}

const MAX_LOG_LINES = 2000;
const MAX_INPUTS = 25;
const MAX_INPUT_CHARS = 4096;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const SAMPLES = 30;
/** The phone's list and detail stay small; the whole of an event lives on the computer. */
const MAX_ISSUES = 50;
const MAX_EXCEPTIONS = 3;
const MAX_FRAMES = 20;
const MAX_TAGS = 20;
const MAX_NAME = 200;
const MAX_MESSAGE = 500;
const MAX_FAILURE = 300;
/** The shape of the provider's own ids, the same check the desktop's Errors tab makes. */
const ISSUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONNECTION_ID_MAX = 128;

function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

function text(params: unknown, name: string, say: string): string {
  const value = field(params, name);
  if (typeof value !== 'string' || value.length === 0) throw new ManageError('bad-params', say);
  return value;
}

function number(params: unknown, name: string, say: string): number {
  const value = field(params, name);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ManageError('bad-params', say);
  }
  return value;
}

/** What GitHub accepts, so a bad request is turned down here with a clear reason. */
function workflowInputs(params: unknown): Record<string, string> {
  const value = field(params, 'inputs');
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManageError('bad-params', 'Those inputs could not be read.');
  }
  const entries = Object.entries(value);
  const valid =
    entries.length <= MAX_INPUTS &&
    entries.every(
      ([name, text]) =>
        INPUT_NAME.test(name) && typeof text === 'string' && text.length <= MAX_INPUT_CHARS,
    );
  if (!valid) throw new ManageError('bad-params', 'Those inputs could not be read.');
  return Object.fromEntries(entries) as Record<string, string>;
}

function shorten(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function errorRef(params: unknown): ErrorIssueRef {
  const connectionId = text(params, 'connectionId', 'Say which connection.');
  const issueId = text(params, 'issueId', 'Say which issue.');
  if (connectionId.length > CONNECTION_ID_MAX || !ISSUE_ID.test(issueId)) {
    throw new ManageError('bad-params', 'That is not an issue this computer knows.');
  }
  return { connectionId, issueId };
}

function failureText(error: unknown): string {
  return shorten(error instanceof Error ? error.message : String(error), MAX_FAILURE);
}

function issueOf(issue: ErrorIssueSummary, now: number): ManageErrorIssue {
  const lastSeen = Date.parse(issue.lastSeen);
  return {
    connectionId: issue.connectionId,
    id: issue.id,
    shortId: issue.shortId,
    title: shorten(issue.title, MAX_NAME),
    culprit: shorten(issue.culprit, MAX_NAME),
    level: issue.level,
    status: issue.status,
    count: issue.count,
    userCount: issue.userCount,
    isNew: issue.isNew,
    projectId: issue.projectId,
    remoteProject: issue.remoteProjectSlug,
    lastSeenAgoMs: Number.isNaN(lastSeen) ? null : now - lastSeen,
  };
}

/** The app's own frames, throwing frame first. All of them when none of them is the app's. */
function framesOf(frames: readonly ErrorFrame[]) {
  const thrownFirst = [...frames].reverse();
  const own = thrownFirst.filter((frame) => frame.inApp);
  return (own.length > 0 ? own : thrownFirst).slice(0, MAX_FRAMES).map((frame) => ({
    file: shorten(frame.filename || frame.module || 'Unknown file', MAX_NAME),
    function: frame.function === null ? null : shorten(frame.function, MAX_NAME),
    line: frame.lineNo,
  }));
}

function eventOf(event: ErrorEvent): NonNullable<ManageErrorDetail['event']> {
  return {
    message: event.message === null ? null : shorten(event.message, MAX_MESSAGE),
    environment: event.environment === null ? null : shorten(event.environment, MAX_NAME),
    release: event.release === null ? null : shorten(event.release, MAX_NAME),
    request: event.request
      ? shorten([event.request.method, event.request.url].filter(Boolean).join(' '), MAX_MESSAGE)
      : null,
    // Cause first on the wire; the phone reads the one that was thrown first, as the desktop does.
    exceptions: [...event.exceptions]
      .reverse()
      .slice(0, MAX_EXCEPTIONS)
      .map((one) => ({
        type: shorten(one.type, MAX_NAME),
        value: shorten(one.value, MAX_MESSAGE),
        handled: one.handled,
        frames: framesOf(one.frames),
      })),
    tags: event.tags.slice(0, MAX_TAGS).map((tag) => ({
      key: shorten(tag.key, MAX_NAME),
      value: shorten(tag.value, MAX_NAME),
    })),
  };
}

function runOf(run: GithubWorkflowRunInfo): ManagePipelineRun {
  return {
    id: run.id,
    title: run.displayTitle,
    branch: run.headBranch,
    number: run.runNumber,
    status: run.status,
    conclusion: run.conclusion,
  };
}

function statusProblem(status: ProjectPipelineStatus): string | null {
  if (!status.cliAvailable) return "GitHub CLI isn't installed on this computer.";
  if (!status.authenticated) return "GitHub CLI isn't signed in on this computer.";
  if (!status.github) return "This project isn't on GitHub.";
  return status.error ?? null;
}

async function repository(deps: ManagePipelineDeps, projectId: string): Promise<string> {
  const repo = await deps.repoOf(projectId);
  if (!repo) throw new ManageError('failed', "This project isn't on GitHub.");
  return repo;
}

function outcome(result: GithubPipelineActionResult, done: string) {
  return result.ok ? { ok: true, message: done } : { ok: false, message: result.error };
}

function jobLogOf(result: GithubJobLogResult): ManageJobLog {
  if (!result.ok) throw new ManageError('failed', result.error);
  const lines = result.steps.flatMap((step) =>
    step.lines.map((line) => ({ text: line.text, error: line.kind === 'error' })),
  );
  return { truncated: lines.length > MAX_LOG_LINES, lines: lines.slice(-MAX_LOG_LINES) };
}

export function opsMethods(
  monitoring: ManageMonitoringDeps,
  pipelines: ManagePipelineDeps,
  errorTracking: ManageErrorTrackingDeps,
): ManageMethods['calls'] {
  const project = (params: unknown) => text(params, 'projectId', 'Say which project.');
  return {
    'monitoring.list': async (): Promise<ManageLocalMonitor[]> =>
      (await monitoring.list())
        .filter((target) => target.cloud === null)
        .map((target) => ({
          id: target.id,
          name: target.name,
          state: target.state,
          paused: target.paused,
          latencyMs: target.latencyMs,
          uptime24h: target.uptime24h,
          headline: target.headline,
          samples: target.samples.slice(-SAMPLES).flatMap((sample) => sample.latencyMs ?? []),
        })),
    'monitoring.check': async (params) => {
      await monitoring.check(text(params, 'id', 'Say which monitor.'));
      return { ok: true, message: 'Checked.' };
    },
    'monitoring.pause': async (params) => {
      const paused = field(params, 'paused');
      if (typeof paused !== 'boolean') throw new ManageError('bad-params', 'Pause or resume?');
      await monitoring.setPaused(text(params, 'id', 'Say which monitor.'), paused);
      return { ok: true, message: paused ? 'Paused.' : 'Resumed.' };
    },
    'pipelines.status': async (params): Promise<ManagePipelineStatus> => {
      const status = await pipelines.status(project(params));
      return {
        problem: statusProblem(status),
        workflows: status.workflows.map((workflow) => {
          const run = status.runsByWorkflowId[workflow.id];
          return {
            id: workflow.id,
            name: workflow.name,
            canDispatch: workflow.dispatchable,
            inputs: workflow.dispatchInputs,
            run: run ? runOf(run) : null,
          };
        }),
      };
    },
    'pipelines.run': async (params) => {
      const repo = await repository(pipelines, project(params));
      const details = await pipelines.details({
        repo,
        runId: number(params, 'runId', 'Say which run.'),
      });
      if (!details.ok) throw new ManageError('failed', details.error);
      return {
        jobs: details.jobs.map(({ id, name, status, conclusion }) => ({
          id,
          name,
          status,
          conclusion,
        })),
      };
    },
    'pipelines.jobLog': async (params) => {
      const repo = await repository(pipelines, project(params));
      const jobId = number(params, 'jobId', 'Say which job.');
      const details = await pipelines.details({
        repo,
        runId: number(params, 'runId', 'Say which run.'),
      });
      if (!details.ok) throw new ManageError('failed', details.error);
      const job = details.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new ManageError('failed', 'That job is gone.');
      return jobLogOf(await pipelines.jobLog({ repo, jobId, steps: job.steps }));
    },
    'pipelines.dispatch': async (params) => {
      const projectId = project(params);
      const repo = await repository(pipelines, projectId);
      const workflowId = number(params, 'workflowId', 'Say which workflow.');
      const inputs = workflowInputs(params);
      const refs = await pipelines.refs(repo);
      if (!refs.ok) return { ok: false, message: refs.error };
      const result = await pipelines.dispatch({
        repo,
        workflowId,
        ref: refs.defaultBranch,
        inputs,
      });
      if (result.ok) pipelines.afterAction(projectId);
      return outcome(result, 'Started.');
    },
    'pipelines.cancel': async (params) => {
      const projectId = project(params);
      const repo = await repository(pipelines, projectId);
      const result = await pipelines.cancel({
        repo,
        runId: number(params, 'runId', 'Say which run.'),
      });
      if (result.ok) pipelines.afterAction(projectId);
      return outcome(result, 'Cancelled.');
    },
    'errors.list': async (): Promise<ManageErrorList> => {
      const [page, linked] = await Promise.all([
        errorTracking.issues({ status: 'unresolved', period: '14d', sort: 'lastSeen' }),
        errorTracking.linked(),
      ]);
      const now = errorTracking.now();
      return {
        linked,
        issues: page.issues.slice(0, MAX_ISSUES).map((issue) => issueOf(issue, now)),
        truncated: page.issues.length > MAX_ISSUES || page.nextCursor !== null,
        problems: page.failures.map((failure) => ({
          label: failure.label,
          message: shorten(failure.message, MAX_FAILURE),
          locked: failure.locked,
        })),
      };
    },
    'errors.show': async (params): Promise<ManageErrorDetail> => {
      const ref = errorRef(params);
      let detail: ErrorIssueDetail;
      try {
        detail = await errorTracking.issue(ref);
      } catch (error) {
        throw new ManageError('failed', failureText(error));
      }
      return {
        issue: issueOf(detail.issue, errorTracking.now()),
        canChange: detail.canWrite,
        event: detail.event ? eventOf(detail.event) : null,
      };
    },
    'errors.setStatus': async (params) => {
      const ref = errorRef(params);
      const status = field(params, 'status');
      if (status !== 'resolved' && status !== 'unresolved') {
        throw new ManageError('bad-params', 'Resolve or reopen?');
      }
      try {
        await errorTracking.setStatus({ ...ref, status });
      } catch (error) {
        return { ok: false, message: failureText(error) };
      }
      return { ok: true, message: status === 'resolved' ? 'Resolved.' : 'Reopened.' };
    },
  };
}
