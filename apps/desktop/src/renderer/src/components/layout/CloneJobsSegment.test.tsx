import type { CloneJob } from '@shared/apiTypes';
import { act, screen, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CloneJobsSegment } from './CloneJobsSegment';

function job(overrides: Partial<CloneJob> = {}): CloneJob {
  return {
    id: 'j1',
    projectId: 'p1',
    projectName: 'My app',
    repoUrl: 'https://github.com/acme/my-app',
    repoLabel: 'acme/my-app',
    folderPath: 'C:/code/my-app',
    attach: false,
    status: 'running',
    phase: 'receiving',
    percent: 58,
    startedAt: Date.now(),
    ...overrides,
  };
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function render(jobs: CloneJob[]) {
  useCloneJobsStore.getState().setJobs(jobs);
  return renderWithProviders(
    <>
      <CloneJobsSegment />
      <Where />
    </>,
  );
}

describe('CloneJobsSegment', () => {
  it('is not there while nothing clones', () => {
    render([]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the one clone under way and how far it is', () => {
    render([job()]);

    const button = screen.getByRole('button', { name: 'Cloning My app' });
    expect(button).toHaveTextContent('Cloning My app');
    expect(button).toHaveTextContent('58%');
  });

  it('adds several clones up into one number', () => {
    render([job(), job({ id: 'j2', projectId: 'p2', projectName: 'Other', percent: 20 })]);

    const button = screen.getByRole('button', { name: 'Cloning 2 projects' });
    expect(button).toHaveTextContent('2 clones');
    expect(button).toHaveTextContent('39%');
  });

  it('keeps a failed clone in sight until it is dealt with', () => {
    render([job({ status: 'failed', message: 'Repository not found.' })]);

    expect(screen.getByRole('button', { name: "Couldn't clone My app" })).toHaveTextContent(
      'Clone failed',
    );
  });

  it('shows a finished clone as ready while it lingers', () => {
    render([job({ status: 'succeeded', percent: 100 })]);

    expect(screen.getByRole('button', { name: 'My app is ready' })).toBeInTheDocument();
  });

  it('leaves out clones the user stopped', () => {
    render([job({ status: 'cancelled' })]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a panel with each clone and a way into its project', async () => {
    const { user } = render([job({ status: 'succeeded', percent: 100 })]);

    await user.click(screen.getByRole('button', { name: 'My app is ready' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Clones')).toBeInTheDocument();
    expect(within(panel).getByText('Cloned acme/my-app')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Open project' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1?tab=git');
  });

  it('follows the store as the clone moves on', () => {
    render([job()]);
    act(() => useCloneJobsStore.getState().setJobs([job({ percent: 91 })]));
    expect(screen.getByRole('button', { name: 'Cloning My app' })).toHaveTextContent('91%');
  });
});
