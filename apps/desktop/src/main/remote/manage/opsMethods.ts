import type {
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

const MAX_LOG_LINES = 2000;
const SAMPLES = 30;

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
      const refs = await pipelines.refs(repo);
      if (!refs.ok) return { ok: false, message: refs.error };
      const result = await pipelines.dispatch({
        repo,
        workflowId,
        ref: refs.defaultBranch,
        inputs: {},
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
  };
}
