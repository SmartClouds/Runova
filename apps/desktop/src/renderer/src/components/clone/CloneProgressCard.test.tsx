import type { CloneJob } from '@shared/apiTypes';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CloneProgressCard } from './CloneProgressCard';

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
    receivedBytes: 12 * 1024 * 1024,
    bytesPerSecond: 2 * 1024 * 1024,
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('CloneProgressCard', () => {
  it('shows a running clone: what it is doing, how far, and how fast', () => {
    renderWithProviders(<CloneProgressCard job={job()} variant="full" />);

    expect(screen.getByText('Cloning acme/my-app')).toBeInTheDocument();
    expect(screen.getByText('Downloading')).toBeInTheDocument();
    expect(screen.getByText(/12\.0 MB · 2\.0 MB\/s/)).toBeInTheDocument();
    expect(screen.getByText('58%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Cloning acme/my-app' });
    expect(bar).toHaveAttribute('aria-valuenow', '58');
    expect(bar).toHaveAttribute('aria-valuetext', 'Downloading, 58%');
  });

  it('stops a running clone', async () => {
    const { user, bridge } = renderWithProviders(
      <CloneProgressCard job={job()} variant="compact" />,
      {
        bridge: { 'git.cancelClone': async () => true },
      },
    );

    await user.click(screen.getByRole('button', { name: 'Stop cloning acme/my-app' }));

    expect(bridge.$fn('git.cancelClone')).toHaveBeenCalledWith('j1');
  });

  it('says why a clone failed and offers to try again or put it away', async () => {
    const failed = job({ status: 'failed', message: 'Repository not found. Check the address.' });
    useCloneJobsStore.getState().setJobs([failed]);
    const { user, bridge } = renderWithProviders(
      <CloneProgressCard job={failed} variant="full" />,
      {
        bridge: {
          'git.startClone': async () => ({ ok: true, message: 'Cloning.', job: job({ id: 'j2' }) }),
          'git.dismissClone': async () => true,
        },
      },
    );

    expect(screen.getByText("Couldn't clone acme/my-app")).toBeInTheDocument();
    expect(screen.getByText('Repository not found. Check the address.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-tone', 'danger');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(bridge.$fn('git.startClone')).toHaveBeenCalledWith({
      projectId: 'p1',
      repoUrl: 'https://github.com/acme/my-app',
      attach: false,
    });

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(bridge.$fn('git.dismissClone')).toHaveBeenCalledWith('j1');
  });

  it('shows a stopped clone quietly, with the same way back', () => {
    renderWithProviders(<CloneProgressCard job={job({ status: 'cancelled' })} variant="full" />);

    expect(screen.getByText('Stopped cloning acme/my-app')).toBeInTheDocument();
    expect(screen.getByText('The folder was left empty.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-tone', 'muted');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('turns green with a way into the project once the clone is done', async () => {
    const onOpen = vi.fn();
    const { user } = renderWithProviders(
      <CloneProgressCard
        job={job({ status: 'succeeded', percent: 100 })}
        variant="full"
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText('Cloned acme/my-app')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-tone', 'success');
    await user.click(screen.getByRole('button', { name: 'Open project' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('tells a screen reader about each step, not every percent', () => {
    function FromStore(): React.JSX.Element | null {
      const current = useCloneJobsStore((state) => state.jobs[0]);
      return current ? <CloneProgressCard job={current} variant="compact" /> : null;
    }
    useCloneJobsStore.getState().setJobs([job()]);
    renderWithProviders(<FromStore />);
    const live = screen.getByTestId('clone-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Cloning acme/my-app: Downloading');

    act(() => useCloneJobsStore.getState().setJobs([job({ percent: 70 })]));
    expect(live).toHaveTextContent('Cloning acme/my-app: Downloading');

    act(() => useCloneJobsStore.getState().setJobs([job({ status: 'failed', message: 'Nope.' })]));
    expect(live).toHaveTextContent("Couldn't clone acme/my-app: Nope.");
  });

  it('lets the store know it is on screen while mounted', async () => {
    const { unmount } = renderWithProviders(<CloneProgressCard job={job()} variant="compact" />);
    expect(useCloneJobsStore.getState().visible.j1).toBe(1);

    unmount();
    await waitFor(() => expect(useCloneJobsStore.getState().visible.j1).toBeUndefined());
  });

  it('says connecting for a folder that already had files', () => {
    renderWithProviders(
      <CloneProgressCard job={job({ attach: true, phase: null, percent: 0 })} variant="full" />,
    );

    expect(screen.getByText('Connecting to acme/my-app')).toBeInTheDocument();
  });
});
