import type { GithubRunJob, GithubRunStep, PipelineConclusion } from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RerunConfirmDialog } from './RerunConfirmDialog';
import type { RerunScope } from './rerunPlan';

function step(number: number, name: string, conclusion: PipelineConclusion): GithubRunStep {
  return {
    number,
    name,
    status: 'completed',
    conclusion,
    startedAt: conclusion === 'skipped' ? null : '2026-03-15T09:00:00Z',
    completedAt: conclusion === 'skipped' ? null : '2026-03-15T09:00:40Z',
  };
}

function job(
  id: number,
  name: string,
  conclusion: PipelineConclusion,
  steps: GithubRunStep[] = [],
): GithubRunJob {
  return {
    id,
    name,
    status: 'completed',
    conclusion,
    startedAt: '2026-03-15T09:00:00Z',
    completedAt: '2026-03-15T09:02:05Z',
    htmlUrl: null,
    runnerName: null,
    steps,
  };
}

const JOBS: GithubRunJob[] = [
  job(1, 'lint', 'success', [step(1, 'Set up job', 'success')]),
  job(2, 'test', 'failure', [
    step(1, 'Set up job', 'success'),
    step(2, 'Run tests', 'failure'),
    step(3, 'Upload report', 'skipped'),
  ]),
  job(3, 'build', 'cancelled', [step(1, 'Set up job', 'cancelled')]),
  job(4, 'deploy', 'skipped'),
];

const run = {
  id: 100,
  status: 'completed' as const,
  runAttempt: 1,
  runNumber: 7,
  headBranch: 'master',
  headSha: 'abc1234def5678',
};

const runDetails = vi.fn();
const onConfirm = vi.fn();
const onOpenChange = vi.fn();

function renderDialog(scope: RerunScope = 'failed') {
  return renderWithProviders(
    <RerunConfirmDialog
      open
      onOpenChange={onOpenChange}
      scope={scope}
      repo="acme/app"
      workflowName="CD"
      run={run}
      onConfirm={onConfirm}
    />,
    { bridge: { 'pipelines.runDetails': runDetails } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runDetails.mockResolvedValue({ ok: true, jobs: JOBS });
});

describe('RerunConfirmDialog', () => {
  it('is named after what it re-runs and says which run and commit', async () => {
    renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Re-run failed jobs of CD?' });
    expect(within(dialog).getByText('Run #7 · master · abc1234')).toBeInTheDocument();
  });

  it('lists the jobs that run again, the failed one open on its steps', async () => {
    renderDialog();
    const list = await screen.findByRole('list', { name: 'Jobs that run again' });
    expect(within(list).getByRole('button', { name: /^test, Failed/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(list).getByRole('button', { name: /^build, Cancelled/ })).toBeInTheDocument();
    expect(within(list).queryByText('lint')).not.toBeInTheDocument();

    const steps = within(list).getByRole('list', { name: 'test steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    const failed = within(steps).getByText('Run tests').closest('li') as HTMLElement;
    expect(within(failed).getByText('Failed here')).toBeInTheDocument();
    expect(within(list).getByText('All 3 steps run again')).toBeInTheDocument();
  });

  it('folds a job open and shut', async () => {
    const { user } = renderDialog();
    const list = await screen.findByRole('list', { name: 'Jobs that run again' });
    const build = within(list).getByRole('button', { name: /^build/ });
    expect(build).toHaveAttribute('aria-expanded', 'false');
    await user.click(build);
    expect(build).toHaveAttribute('aria-expanded', 'true');
    expect(within(list).getByRole('list', { name: 'build steps' })).toBeInTheDocument();
  });

  it('says skipped jobs may run again', async () => {
    renderDialog();
    const maybe = await screen.findByRole('list', { name: 'Jobs that may run again' });
    expect(within(maybe).getByText('deploy')).toBeInTheDocument();
  });

  it('folds the jobs that keep their result into one line', async () => {
    const { user } = renderDialog();
    const toggle = await screen.findByRole('button', { name: '1 job keeps its result' });
    expect(screen.queryByRole('list', { name: 'Jobs that keep their result' })).toBeNull();
    await user.click(toggle);
    const kept = screen.getByRole('list', { name: 'Jobs that keep their result' });
    expect(within(kept).getByText('lint')).toBeInTheDocument();
  });

  it('counts the jobs on the confirm button and confirms', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Re-run 2 jobs' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('lists every job and warns about deploys when re-running all of them', async () => {
    renderDialog('all');
    const dialog = await screen.findByRole('dialog', { name: 'Re-run all jobs of CD?' });
    const list = await within(dialog).findByRole('list', { name: 'Jobs that run again' });
    for (const name of ['lint', 'test', 'build', 'deploy']) {
      expect(within(list).getByRole('button', { name: new RegExp(`^${name},`) })).toBeVisible();
    }
    expect(within(dialog).getByText(/deploys or publishes happens again/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Re-run 4 jobs' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Jobs that may run again' })).toBeNull();
  });

  it('shimmers while the jobs load and can still confirm', async () => {
    runDetails.mockImplementation(() => new Promise(() => undefined));
    const { user } = renderDialog();
    expect(await screen.findByRole('status', { name: 'Loading jobs' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Re-run failed jobs' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('falls back to saying what happens when the jobs cannot be read', async () => {
    runDetails.mockResolvedValue({ ok: false, error: 'gh is not signed in' });
    renderDialog();
    expect(
      await screen.findByText(/failed or were cancelled start again on the same commit/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run failed jobs' })).toBeEnabled();
  });

  it('falls back to the same words when no job ended badly', async () => {
    runDetails.mockResolvedValue({ ok: true, jobs: [] });
    renderDialog();
    expect(
      await screen.findByText(/failed or were cancelled start again on the same commit/),
    ).toBeInTheDocument();
  });

  it('closes without re-running on Cancel', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('puts the focus on the confirm button so Enter re-runs', async () => {
    renderDialog();
    expect(await screen.findByRole('button', { name: 'Re-run 2 jobs' })).toHaveFocus();
  });
});
