import type { Project } from '@runova/core';
import type {
  DurationEstimate,
  GithubRunAnnotation,
  GithubRunJob,
  GithubWorkflowInfo,
  GithubWorkflowRunInfo,
  RunEstimates,
} from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RunDetails } from './RunDetails';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
vi.mock('./FixStepDialog', () => ({
  FixStepDialog: ({
    open,
    project,
    target,
  }: {
    open: boolean;
    project: Project;
    target: Record<string, unknown>;
  }) =>
    open ? (
      <div role="dialog" aria-label="Fix step">
        {JSON.stringify({ project: project.id, ...target })}
      </div>
    ) : null,
}));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;

const workflow: GithubWorkflowInfo = {
  id: 1,
  name: 'CD',
  path: '.github/workflows/cd.yml',
  state: 'active',
  htmlUrl: 'https://github.com/acme/app/actions/workflows/cd.yml',
  badgeUrl: '',
  dispatchable: false,
  dispatchInputs: [],
};

const hoursAgo = (hours: number, extraSeconds = 0) =>
  new Date(Date.now() - hours * 3_600_000 + extraSeconds * 1000).toISOString();

const FAILED_RUN: GithubWorkflowRunInfo = {
  id: 100,
  workflowId: 1,
  name: 'CD',
  displayTitle: 'fix(desktop): stop click-swallow timer',
  runNumber: 7,
  headBranch: 'master',
  status: 'completed',
  conclusion: 'failure',
  htmlUrl: 'https://github.com/acme/app/actions/runs/100',
  createdAt: hoursAgo(3),
  updatedAt: hoursAgo(3, 252),
  event: 'push',
  actor: 'octo',
  headSha: 'abc1234def5678',
  runAttempt: 2,
};

const PASSED_RUN: GithubWorkflowRunInfo = {
  ...FAILED_RUN,
  id: 101,
  conclusion: 'success',
  runAttempt: 1,
};

const LIVE_RUN: GithubWorkflowRunInfo = {
  ...FAILED_RUN,
  id: 102,
  status: 'in_progress',
  conclusion: null,
  runAttempt: 1,
  updatedAt: hoursAgo(3),
};

function job(overrides: Partial<GithubRunJob> = {}): GithubRunJob {
  return {
    id: 11,
    name: 'deploy',
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2026-03-15T09:00:00Z',
    completedAt: '2026-03-15T09:04:35Z',
    htmlUrl: 'https://github.com/acme/app/actions/runs/100/job/11',
    runnerName: null,
    steps: [
      {
        number: 1,
        name: 'Run deploy',
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-03-15T09:00:00Z',
        completedAt: '2026-03-15T09:04:30Z',
      },
    ],
    ...overrides,
  };
}

const annotation: GithubRunAnnotation = {
  level: 'warning',
  jobName: 'deploy',
  path: '.github',
  startLine: null,
  endLine: null,
  title: 'Deprecated',
  message: 'node 18 is old',
};

const openExternal = vi.fn();
const runDetails = vi.fn();
const runAnnotations = vi.fn();
const runError = vi.fn();

function renderDetails(run: GithubWorkflowRunInfo | null, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <RunDetails project={project} repo="acme/app" workflow={workflow} run={run} />,
    {
      bridge: {
        'shell.openExternal': openExternal,
        'pipelines.runDetails': runDetails,
        'pipelines.runAnnotations': runAnnotations,
        'pipelines.runError': runError,
        'pipelines.cancelRun': { ok: true },
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runDetails.mockResolvedValue({ ok: true, jobs: [job()] });
  runAnnotations.mockResolvedValue({
    ok: true,
    annotations: [],
    counts: { failure: 0, warning: 0, notice: 0 },
  });
  runError.mockResolvedValue({ ok: true, text: 'Job: deploy\n  Step: Run deploy (failure)' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RunDetails header', () => {
  it('names the pipeline, the commit and how the run ended', async () => {
    renderDetails(FAILED_RUN);

    const pane = screen.getByRole('region', { name: 'CD details' });
    expect(within(pane).getByRole('heading', { name: 'CD' })).toBeInTheDocument();
    expect(within(pane).getByText('fix(desktop): stop click-swallow timer')).toBeInTheDocument();
    expect(within(pane).getByText('Failed')).toBeInTheDocument();
  });

  it('lists the branch, run number, attempt, trigger, author and commit', () => {
    renderDetails(FAILED_RUN);

    expect(screen.getByText('master')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText('push')).toBeInTheDocument();
    expect(screen.getByText('by octo')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('leaves out what GitHub did not tell it, and the attempt of a first run', () => {
    renderDetails({
      ...PASSED_RUN,
      event: undefined,
      actor: undefined,
      headSha: undefined,
      runAttempt: undefined,
    });

    expect(screen.queryByText(/Attempt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^by /)).not.toBeInTheDocument();
    expect(screen.queryByText('push')).not.toBeInTheDocument();
  });

  it('says when it started and how long it took', () => {
    renderDetails(FAILED_RUN);
    expect(screen.getByText(/Started 3h ago/)).toHaveTextContent('took 4m 12s');
  });

  it('says how long a live run has been going instead', () => {
    renderDetails(LIVE_RUN);
    expect(screen.getByText(/Started 3h ago/)).toHaveTextContent(/running for/);
  });

  it('opens the run on GitHub', async () => {
    const { user } = renderDetails(FAILED_RUN);
    await user.click(screen.getByRole('button', { name: 'Open run on GitHub' }));
    expect(openExternal).toHaveBeenCalledWith(FAILED_RUN.htmlUrl);
  });

  it('offers Fix with AI and Copy error only on a failed run', () => {
    const failed = renderDetails(FAILED_RUN);
    expect(screen.getByRole('button', { name: /Fix with AI/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy error/ })).toBeInTheDocument();
    failed.unmount();

    renderDetails(PASSED_RUN);
    expect(screen.queryByRole('button', { name: /Fix with AI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy error/ })).not.toBeInTheDocument();
  });

  it('offers Stop only while the run is still going', () => {
    const live = renderDetails(LIVE_RUN);
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument();
    live.unmount();

    renderDetails(FAILED_RUN);
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument();
  });
});

describe('RunDetails re-run', () => {
  const rerunRun = vi.fn();
  const status = vi.fn();

  beforeEach(() => {
    rerunRun.mockResolvedValue({ ok: true });
    status.mockResolvedValue(null);
  });

  function renderRerun(run: GithubWorkflowRunInfo) {
    return renderDetails(run, {
      'pipelines.rerunRun': rerunRun,
      'pipelines.status': status,
    });
  }

  async function pick(label: string): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Re-run jobs' }));
    await user.click(await screen.findByRole('menuitem', { name: new RegExp(`^${label}`) }));
  }

  async function answerConfirm(yes: boolean, user = userEvent.setup()): Promise<void> {
    const dialog = await screen.findByRole('dialog', { name: /^Re-run .* of CD\?$/ });
    await user.click(within(dialog).getByRole('button', { name: yes ? /^Re-run/ : 'Cancel' }));
  }

  it('offers both choices on a failed or cancelled run', async () => {
    const failed = renderRerun(FAILED_RUN);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Re-run jobs' }));
    expect(await screen.findByRole('menuitem', { name: /^Re-run all jobs/ })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /^Re-run failed jobs/ })).toBeVisible();
    failed.unmount();

    renderRerun({ ...FAILED_RUN, conclusion: 'cancelled' });
    expect(screen.getByRole('button', { name: 'Re-run jobs' })).toBeVisible();
  });

  it('is one plain button when nothing failed, since there is only one choice', () => {
    renderRerun(PASSED_RUN);
    expect(screen.getByRole('button', { name: 'Re-run all jobs' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Re-run jobs' })).not.toBeInTheDocument();
  });

  it('is not offered while the run is still going', () => {
    renderRerun(LIVE_RUN);
    expect(screen.queryByRole('button', { name: /^Re-run/ })).not.toBeInTheDocument();
  });

  it('asks first, showing the jobs that run again, then re-runs only the failed jobs', async () => {
    renderRerun(FAILED_RUN);
    await pick('Re-run failed jobs');
    const dialog = await screen.findByRole('dialog', { name: 'Re-run failed jobs of CD?' });
    const list = await within(dialog).findByRole('list', { name: 'Jobs that run again' });
    expect(within(list).getByRole('button', { name: /^deploy, Failed/ })).toBeInTheDocument();
    expect(within(list).getByText('Failed here')).toBeInTheDocument();
    await answerConfirm(true);

    await waitFor(() =>
      expect(rerunRun).toHaveBeenCalledWith({ repo: 'acme/app', runId: 100, scope: 'failed' }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Asked GitHub to re-run the failed jobs.'),
    );
  });

  it('warns that re-running everything repeats what the pipeline deploys', async () => {
    renderRerun(FAILED_RUN);
    await pick('Re-run all jobs');
    const dialog = await screen.findByRole('dialog', { name: 'Re-run all jobs of CD?' });
    expect(within(dialog).getByText(/deploys or publishes happens again/)).toBeInTheDocument();
    await answerConfirm(true);

    await waitFor(() =>
      expect(rerunRun).toHaveBeenCalledWith({ repo: 'acme/app', runId: 100, scope: 'all' }),
    );
  });

  it('does nothing when the confirmation is declined', async () => {
    renderRerun(PASSED_RUN);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Re-run all jobs' }));
    await answerConfirm(false);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(rerunRun).not.toHaveBeenCalled();
  });

  it('shows why GitHub refused and lets the user try again', async () => {
    rerunRun.mockResolvedValue({ ok: false, error: 'That run has already started again.' });
    renderRerun(PASSED_RUN);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Re-run all jobs' }));
    await answerConfirm(true);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That run has already started again.'),
    );
    expect(screen.getByRole('button', { name: 'Re-run all jobs' })).toBeEnabled();
  });

  it('holds on Starting until GitHub shows the new attempt', async () => {
    let showRun: (run: GithubWorkflowRunInfo) => void = () => undefined;
    function ChangingRun(): React.JSX.Element {
      const [run, setRun] = useState(PASSED_RUN);
      showRun = setRun;
      return <RunDetails project={project} repo="acme/app" workflow={workflow} run={run} />;
    }
    renderWithProviders(<ChangingRun />, {
      bridge: {
        'pipelines.runDetails': runDetails,
        'pipelines.runAnnotations': runAnnotations,
        'pipelines.rerunRun': rerunRun,
      },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Re-run all jobs' }));
    await answerConfirm(true);

    expect(await screen.findByRole('button', { name: 'Starting' })).toBeDisabled();

    act(() => showRun({ ...PASSED_RUN, runAttempt: 2 }));
    expect(await screen.findByRole('button', { name: 'Re-run all jobs' })).toBeEnabled();
  });

  it('keeps asking GitHub while it waits, and comes back if the attempt never shows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    function StatusReader(): null {
      useQuery({ queryKey: queryKeys.pipelineStatus(project.id), queryFn: status });
      return null;
    }
    renderWithProviders(
      <>
        <StatusReader />
        <RunDetails project={project} repo="acme/app" workflow={workflow} run={PASSED_RUN} />
      </>,
      {
        bridge: {
          'pipelines.runDetails': runDetails,
          'pipelines.runAnnotations': runAnnotations,
          'pipelines.rerunRun': rerunRun,
        },
      },
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Re-run all jobs' }));
    await answerConfirm(true, user);
    await screen.findByRole('button', { name: 'Starting' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(status.mock.calls.length).toBeGreaterThan(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole('button', { name: 'Re-run all jobs' })).toBeEnabled();
  });
});

describe('RunDetails jobs', () => {
  it('shimmers while the jobs load, then lists them with a summary', async () => {
    let finish: (value: unknown) => void = () => undefined;
    runDetails.mockImplementationOnce(() => new Promise((done) => (finish = done)));
    renderDetails(FAILED_RUN);

    expect(screen.getByTestId('run-jobs-loading')).toBeInTheDocument();

    await act(async () => finish({ ok: true, jobs: [job(), job({ id: 12, name: 'lint' })] }));

    const jobs = await screen.findByRole('region', { name: 'Jobs' });
    expect(within(jobs).getByText('2 failed')).toBeInTheDocument();
    expect(within(jobs).getByRole('button', { name: /^deploy/ })).toBeInTheDocument();
    expect(within(jobs).getByRole('button', { name: /^lint/ })).toBeInTheDocument();
    expect(screen.queryByTestId('run-jobs-loading')).not.toBeInTheDocument();
  });

  it('opens the failed step on its log and fixes it with the run it belongs to', async () => {
    const { user } = renderWithProviders(
      <RunDetails project={project} repo="acme/app" workflow={workflow} run={FAILED_RUN} />,
      {
        bridge: {
          'pipelines.runDetails': runDetails,
          'pipelines.runAnnotations': runAnnotations,
          'pipelines.runError': runError,
          'pipelines.jobLog': async () => ({
            ok: true,
            steps: [
              {
                number: 1,
                lines: [{ text: 'deploy refused: 401', kind: 'error' }],
                errors: 1,
                warnings: 0,
              },
            ],
          }),
        },
      },
    );

    const log = await screen.findByRole('region', { name: 'Run deploy log' });
    expect(await within(log).findByText('deploy refused: 401')).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Fix with AI' }));

    expect(JSON.parse(screen.getByRole('dialog', { name: 'Fix step' }).textContent ?? '')).toEqual({
      project: 'p1',
      repo: 'acme/app',
      jobId: 11,
      jobName: 'deploy',
      stepNumber: 1,
      stepName: 'Run deploy',
      workflowName: 'CD',
      displayTitle: 'fix(desktop): stop click-swallow timer',
      runNumber: 7,
      headBranch: 'master',
    });
  });

  it('asks for the jobs of this run only', async () => {
    renderDetails(FAILED_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    expect(runDetails).toHaveBeenCalledTimes(1);
    expect(runDetails).toHaveBeenCalledWith({ repo: 'acme/app', runId: 100, attempt: 2 });
  });

  it('explains a failed read, keeps the reason in a tooltip, and retries', async () => {
    runDetails.mockResolvedValueOnce({ ok: false, error: 'HTTP 403: Forbidden' });
    const { user } = renderDetails(FAILED_RUN);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the jobs from GitHub.');
    await user.hover(within(alert).getByText('Could not load the jobs from GitHub.'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('HTTP 403: Forbidden');

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('region', { name: 'Jobs' })).toBeInTheDocument();
    expect(runDetails).toHaveBeenCalledTimes(2);
  });

  it('says GitHub has not started a queued run’s jobs', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [] });
    renderDetails({ ...LIVE_RUN, status: 'queued' });
    expect(await screen.findByText('GitHub has not started any jobs yet.')).toBeInTheDocument();
  });

  it('says a finished run had no jobs', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [] });
    renderDetails({ ...PASSED_RUN });
    expect(await screen.findByText('No jobs ran for this run.')).toBeInTheDocument();
  });

  it('keeps a running job’s clock moving between reads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runDetails.mockResolvedValue({
      ok: true,
      jobs: [
        job({
          status: 'in_progress',
          conclusion: null,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          completedAt: null,
          steps: [],
        }),
      ],
    });
    renderDetails(LIVE_RUN);
    const button = await screen.findByRole('button', { name: /^deploy/ });
    const before = button.textContent;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByRole('button', { name: /^deploy/ }).textContent).not.toBe(before);
  });
});

describe('RunDetails estimates', () => {
  const runEstimates = vi.fn();

  function usual(ms: number): DurationEstimate {
    return { ms, lowMs: ms, highMs: ms, samples: 6, confidence: 'high' };
  }

  function estimates(runMs: number, jobs: RunEstimates['jobs'] = {}) {
    return { ok: true, estimates: { runs: 6, run: usual(runMs), jobs } satisfies RunEstimates };
  }

  const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  /** A run made ten minutes ago that waited for a runner until two minutes ago. */
  function freshLiveRun(): GithubWorkflowRunInfo {
    return { ...LIVE_RUN, id: 103, createdAt: secondsAgo(600) };
  }

  /** Its job, running for the last two minutes. */
  const startedJobs = () => ({
    ok: true,
    jobs: [
      job({
        status: 'in_progress',
        conclusion: null,
        startedAt: secondsAgo(120),
        completedAt: null,
        steps: [],
      }),
    ],
  });

  it('asks how long this pipeline usually takes, leaving the run itself out', async () => {
    runEstimates.mockResolvedValue(estimates(300_000));
    renderDetails(freshLiveRun(), { 'pipelines.runEstimates': runEstimates });

    await waitFor(() =>
      expect(runEstimates).toHaveBeenCalledWith({
        repo: 'acme/app',
        workflowId: 1,
        excludeRunId: 103,
      }),
    );
  });

  it('counts a live run down from its first job, not from the wait before it', async () => {
    runDetails.mockResolvedValue(startedJobs());
    runEstimates.mockResolvedValue(estimates(300_000));
    renderDetails(freshLiveRun(), { 'pipelines.runEstimates': runEstimates });

    const bar = await screen.findByRole('progressbar', { name: 'CD progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getByText('~3m left')).toBeInTheDocument();
    expect(screen.getByText(/Started 2m ago/)).toHaveTextContent(/running for 2m 0s/);
  });

  it('does not count down a queued run, only says how long it usually takes', async () => {
    runDetails.mockResolvedValue({
      ok: true,
      // GitHub gives a queued job a start time too.
      jobs: [job({ status: 'queued', conclusion: null, startedAt: secondsAgo(600), steps: [] })],
    });
    runEstimates.mockResolvedValue(estimates(720_000));
    renderDetails(
      { ...freshLiveRun(), status: 'queued' },
      { 'pipelines.runEstimates': runEstimates },
    );

    expect(await screen.findByLabelText('Usually about 12m')).toHaveTextContent('usually ~12m');
    expect(screen.getByText(/Queued 10m ago/)).toHaveTextContent(/waiting 10m 0s/);
    expect(screen.queryByText(/running for|left/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('moves the bar along as the run goes on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runDetails.mockResolvedValue(startedJobs());
    runEstimates.mockResolvedValue(estimates(300_000));
    renderDetails(freshLiveRun(), { 'pipelines.runEstimates': runEstimates });
    const bar = await screen.findByRole('progressbar', { name: 'CD progress' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(50);
  });

  it('counts down the jobs too', async () => {
    runDetails.mockResolvedValue({
      ok: true,
      jobs: [
        job({
          status: 'in_progress',
          conclusion: null,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          completedAt: null,
          steps: [],
        }),
      ],
    });
    runEstimates.mockResolvedValue(
      estimates(300_000, { deploy: { estimate: usual(240_000), steps: {} } }),
    );
    renderDetails(freshLiveRun(), { 'pipelines.runEstimates': runEstimates });

    expect(await screen.findByRole('progressbar', { name: 'deploy progress' })).toBeInTheDocument();
  });

  it('says when a passed run took clearly longer than usual', async () => {
    runDetails.mockResolvedValue({
      ok: true,
      jobs: [
        job({
          conclusion: 'success',
          startedAt: new Date(Date.parse(PASSED_RUN.createdAt) + 12_000).toISOString(),
        }),
      ],
    });
    runEstimates.mockResolvedValue(estimates(180_000));
    renderDetails(PASSED_RUN, { 'pipelines.runEstimates': runEstimates });

    // 4m from its first job (after 12s in the queue) against the usual 3m.
    expect(await screen.findByLabelText('1m 0s slower than usual')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('does not hold a failed run up to the usual time, since it stopped early', async () => {
    runEstimates.mockResolvedValue(estimates(60_000));
    renderDetails(FAILED_RUN, { 'pipelines.runEstimates': runEstimates });

    await waitFor(() => expect(runEstimates).toHaveBeenCalled());
    expect(screen.queryByText(/slower|faster/)).not.toBeInTheDocument();
  });

  it('carries on without estimates when GitHub cannot give them', async () => {
    runEstimates.mockResolvedValue({ ok: false, error: 'HTTP 403' });
    renderDetails(freshLiveRun(), { 'pipelines.runEstimates': runEstimates });

    await waitFor(() => expect(runEstimates).toHaveBeenCalled());
    expect(screen.getByText(/Started/)).toHaveTextContent(/running for/);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('RunDetails annotations', () => {
  it('shows what the run left behind', async () => {
    runAnnotations.mockResolvedValue({
      ok: true,
      annotations: [annotation],
      counts: { failure: 0, warning: 1, notice: 0 },
    });
    renderDetails(FAILED_RUN);

    const section = await screen.findByRole('region', { name: 'Annotations' });
    expect(within(section).getByRole('button', { name: /1 warning/ })).toBeInTheDocument();
  });

  it('leaves the section out when there is nothing', async () => {
    renderDetails(FAILED_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    await waitFor(() => expect(runAnnotations).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Annotations' })).not.toBeInTheDocument();
  });

  it('does not look for annotations on a run that is still going', async () => {
    renderDetails(LIVE_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    expect(runAnnotations).not.toHaveBeenCalled();
  });
});

describe('RunDetails failure output', () => {
  it('stays closed, and does not read the logs, until it is opened', async () => {
    renderDetails(FAILED_RUN);
    const toggle = await screen.findByRole('button', { name: /Failure output/ });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(runError).not.toHaveBeenCalled();
  });

  it('reads the failure when opened and shows it as text', async () => {
    const { user } = renderDetails(FAILED_RUN);

    await user.click(await screen.findByRole('button', { name: /Failure output/ }));

    const section = screen.getByRole('region', { name: 'Failure output' });
    expect(await within(section).findByText(/Step: Run deploy \(failure\)/)).toBeInTheDocument();
    expect(runError).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/app', runId: 100, workflowName: 'CD' }),
    );
  });

  it('shimmers while the failure loads', async () => {
    runError.mockImplementationOnce(() => new Promise(() => undefined));
    const { user } = renderDetails(FAILED_RUN);

    await user.click(await screen.findByRole('button', { name: /Failure output/ }));

    expect(screen.getByTestId('run-failure-loading')).toBeInTheDocument();
  });

  it('copies the failure', async () => {
    const { user } = renderDetails(FAILED_RUN);
    await user.click(await screen.findByRole('button', { name: /Failure output/ }));
    await screen.findByText(/Step: Run deploy/);

    await user.click(screen.getByRole('button', { name: 'Copy failure output' }));

    expect(await navigator.clipboard.readText()).toBe('Job: deploy\n  Step: Run deploy (failure)');
  });

  it('explains a failed read and retries it', async () => {
    runError.mockResolvedValueOnce({ ok: false, error: 'No error details were available.' });
    const { user } = renderDetails(FAILED_RUN);
    await user.click(await screen.findByRole('button', { name: /Failure output/ }));

    const section = screen.getByRole('region', { name: 'Failure output' });
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Could not read the failure.',
    );

    await user.click(within(section).getByRole('button', { name: 'Retry' }));

    expect(await within(section).findByText(/Step: Run deploy/)).toBeInTheDocument();
  });

  it('is not there for a run that passed', async () => {
    renderDetails(PASSED_RUN);
    await screen.findByRole('region', { name: 'Jobs' });
    expect(screen.queryByRole('region', { name: 'Failure output' })).not.toBeInTheDocument();
  });
});

describe('RunDetails for a pipeline that has never run', () => {
  it('says so and opens the workflow on GitHub', async () => {
    const { user } = renderDetails(null);

    expect(screen.getByText('This pipeline has not run yet.')).toBeInTheDocument();
    expect(runDetails).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Open workflow on GitHub' }));
    expect(openExternal).toHaveBeenCalledWith(workflow.htmlUrl);
  });
});

describe('RunDetails auto-fix', () => {
  it('offers auto-fix on a run that is still going', async () => {
    renderDetails(LIVE_RUN);
    expect(
      await screen.findByRole('button', { name: 'Auto-fix this run if it fails' }),
    ).toBeVisible();
  });

  it('shows the session in full when auto-fix is handling the run', async () => {
    renderDetails(LIVE_RUN, {
      'ciAutoFix.list': [
        {
          id: 'fix-1',
          projectId: 'p1',
          projectName: 'App',
          repo: 'acme/app',
          workflowId: 1,
          workflowName: 'CD',
          branch: 'master',
          cliId: 'claude-code',
          runArgs: [],
          runLabel: null,
          maxAttempts: 3,
          runId: LIVE_RUN.id,
          runNumber: LIVE_RUN.runNumber,
          waitFor: null,
          phase: 'watching',
          blocker: null,
          message: null,
          attempts: [],
          agent: null,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    const panel = await screen.findByRole('region', { name: 'Auto-fix' });
    expect(within(panel).getByRole('button', { name: 'Stop auto-fix' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Auto-fix this run if it fails' })).toBeNull();
  });

  it('offers nothing on a finished run auto-fix never handled', async () => {
    renderDetails(FAILED_RUN);
    await screen.findByText(FAILED_RUN.displayTitle);
    expect(screen.queryByRole('button', { name: 'Auto-fix this run if it fails' })).toBeNull();
  });
});
