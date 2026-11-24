import type { CloneJob } from '@shared/apiTypes';
import { act, screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { useToastHistoryStore } from '@/stores/toastHistoryStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CloneJobNotifier } from './CloneJobNotifier';

type ToastOptions = {
  description?: string;
  action?: { label: string; onClick: () => void };
  cancel?: { label: string; onClick: () => void };
};
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  message: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

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
    percent: 40,
    startedAt: 0,
    ...overrides,
  };
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function setJobs(jobs: CloneJob[]): void {
  act(() => useCloneJobsStore.getState().setJobs(jobs));
}

function render() {
  return renderWithProviders(
    <>
      <CloneJobNotifier />
      <Where />
    </>,
    {
      route: '/dashboard',
      bridge: {
        'git.startClone': async () => ({ ok: true, message: 'Cloning.', job: job({ id: 'j2' }) }),
      },
    },
  );
}

function lastOptions(fn: ReturnType<typeof vi.fn>): ToastOptions {
  return fn.mock.calls.at(-1)?.[1] as ToastOptions;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CloneJobNotifier', () => {
  it('says a finished clone is ready, from any page, with a way into the project', () => {
    render();
    setJobs([job()]);
    setJobs([job({ status: 'succeeded', percent: 100 })]);

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success.mock.calls[0]?.[0]).toBe('My app is ready');
    const options = lastOptions(toast.success);
    expect(options.description).toBe('Cloned acme/my-app.');
    expect(options.action?.label).toBe('Open project');

    act(() => options.action?.onClick());
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1?tab=git');
  });

  it('says why a clone failed and offers to try again or look at the Git tab', async () => {
    const { bridge } = render();
    setJobs([job()]);
    setJobs([job({ status: 'failed', message: 'Repository not found.' })]);

    expect(toast.error.mock.calls[0]?.[0]).toBe("Couldn't clone My app");
    const options = lastOptions(toast.error);
    expect(options.description).toBe('Repository not found.');
    expect(options.action?.label).toBe('Try again');
    expect(options.cancel?.label).toBe('Open Git tab');

    await act(async () => options.action?.onClick());
    expect(bridge.$fn('git.startClone')).toHaveBeenCalledWith({
      projectId: 'p1',
      repoUrl: 'https://github.com/acme/my-app',
      attach: false,
    });
    act(() => options.cancel?.onClick());
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1?tab=git');
  });

  it('keeps each result in Recent messages once, linked to the project', () => {
    render();
    useToastHistoryStore.setState({ items: [] });
    setJobs([job()]);
    setJobs([job({ status: 'failed', message: 'Repository not found.' })]);

    expect(useToastHistoryStore.getState().items).toEqual([
      expect.objectContaining({
        kind: 'error',
        title: "Couldn't clone My app",
        link: { route: '/projects/p1?tab=git' },
        projectId: 'p1',
      }),
    ]);
  });

  it('stays quiet about a clone the user stopped', () => {
    render();
    setJobs([job()]);
    setJobs([job({ status: 'cancelled' })]);

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says nothing about jobs that were already over when the app loaded', () => {
    render();
    setJobs([job({ status: 'failed', message: 'Old news.' })]);
    setJobs([job({ status: 'failed', message: 'Old news.' })]);

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('lets the card speak when one is on screen', () => {
    render();
    setJobs([job()]);
    const hide = useCloneJobsStore.getState().showCard('j1');
    setJobs([job({ status: 'succeeded', percent: 100 })]);

    expect(toast.success).not.toHaveBeenCalled();
    hide();
  });

  it('refreshes the project list and the Git tab once a clone ends', () => {
    const { queryClient } = render();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    setJobs([job()]);
    setJobs([job({ status: 'succeeded', percent: 100 })]);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projects });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.gitStatus('p1') });
  });

  it('says connected for a folder that already had files', () => {
    render();
    setJobs([job({ attach: true })]);
    setJobs([job({ attach: true, status: 'succeeded', percent: 100 })]);

    expect(lastOptions(toast.success).description).toBe('Connected to acme/my-app.');
  });
});
