import type {
  CleanupCandidate,
  CleanupRemoveResult,
  ProjectCleanupScan,
} from '@shared/projectCleanupTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectCleanupStore } from '@/stores/projectCleanupStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { project } from '../../health/testing/fixtures';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async (_options: unknown) => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { ProjectCleanupTab } = await import('./ProjectCleanupTab');

const MB = 1024 ** 2;

function candidate(over: Partial<CleanupCandidate>): CleanupCandidate {
  const relPath = over.relPath ?? 'node_modules';
  return {
    id: `main:${relPath}`,
    locationId: 'main',
    relPath,
    name: relPath.split('/').at(-1) ?? relPath,
    category: 'dependencies',
    bytes: 800 * MB,
    sharedBytes: 0,
    files: 5000,
    modifiedAt: Date.now() - 3600_000,
    restore: { label: 'Comes back when you reinstall the dependencies.', command: 'pnpm install' },
    locked: null,
    ...over,
  };
}

/** 800 MB of dependencies, 150 MB of build output, 50 MB of cache, 100 MB of Studio cache. */
function scan(candidates?: CleanupCandidate[]): ProjectCleanupScan {
  return {
    projectId: 'p1',
    scannedAt: Date.now(),
    locations: [
      {
        id: 'main',
        label: 'Project folder',
        path: 'C:/work/storefront',
        branch: null,
        isMain: true,
        totalBytes: 2000 * MB,
        gitBytes: 100 * MB,
        unreadable: 0,
        candidates: candidates ?? [
          candidate({ relPath: 'node_modules' }),
          candidate({
            relPath: 'dist',
            category: 'build',
            bytes: 150 * MB,
            restore: { label: 'Comes back the next time you build the project.', command: null },
          }),
          candidate({
            relPath: '.turbo',
            category: 'cache',
            bytes: 50 * MB,
            restore: { label: 'Tools fill it again.', command: null },
          }),
        ],
      },
    ],
    studio: candidates
      ? []
      : [{ videoId: 'v1', title: 'Launch film', bytes: 100 * MB, busy: false }],
  };
}

function gate<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  confirm.mockReset();
  confirm.mockResolvedValue(true);
});

describe('opening the tab', () => {
  it('scans by itself and shows what the project holds', async () => {
    const { bridge } = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': async () => scan() },
    });
    expect(await screen.findByText(/can be freed/i)).toBeInTheDocument();
    expect(screen.getByText('1.07 GB')).toBeInTheDocument();
    expect(screen.getByText(/uses 2\.05 GB in all/i)).toBeInTheDocument();
    expect(bridge.$fn('projectCleanup.scan')).toHaveBeenCalledWith('p1', expect.any(String));
    for (const name of ['Build output', 'Caches', 'Dependencies', 'Studio render cache']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('remembers the size for the Projects page', async () => {
    renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': async () => scan() },
    });
    await screen.findByText(/can be freed/i);
    expect(useProjectCleanupStore.getState().summaries.p1).toMatchObject({
      totalBytes: 2100 * MB,
      reclaimableBytes: 1100 * MB,
    });
  });

  it('shows what it finds while it is still looking', async () => {
    const held = gate<ProjectCleanupScan>();
    const { bridge } = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': () => held.promise },
    });
    await screen.findByText(/looking through your project/i);
    const requestId = bridge.$fn('projectCleanup.scan').mock.calls[0]?.[1] as string;

    bridge.$emit('projectCleanup.onScanEvent', {
      requestId,
      type: 'location',
      locationId: 'main',
      label: 'Project folder',
      isMain: true,
    });
    bridge.$emit('projectCleanup.onScanEvent', {
      requestId,
      type: 'progress',
      locationId: 'main',
      files: 4200,
    });
    bridge.$emit('projectCleanup.onScanEvent', {
      requestId,
      type: 'candidate',
      candidate: candidate({ relPath: 'node_modules' }),
    });

    expect(await screen.findByText(/4,200 files looked at in project folder/i)).toBeInTheDocument();
    expect(screen.getByText(/found so far/i)).toBeInTheDocument();
    const found = screen.getByRole('checkbox', { name: 'Select node_modules' });
    expect(found).toBeDisabled();

    held.resolve(scan());
    expect(await screen.findByText(/can be freed/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select node_modules' })).toBeEnabled();
  });

  it('ignores the events of some other scan', async () => {
    const held = gate<ProjectCleanupScan>();
    const { bridge } = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': () => held.promise },
    });
    await screen.findByText(/looking through your project/i);
    bridge.$emit('projectCleanup.onScanEvent', {
      requestId: 'another-project',
      type: 'progress',
      locationId: 'main',
      files: 99999,
    });
    expect(screen.queryByText(/99,999/)).not.toBeInTheDocument();
    held.resolve(scan());
    await screen.findByText(/can be freed/i);
  });

  it('opens straight to the last result, without scanning again', async () => {
    useProjectCleanupStore.getState().recordScan('p1', scan());
    const scanCall = vi.fn(async () => scan());
    renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': scanCall },
    });
    expect(await screen.findByText(/can be freed/i)).toBeInTheDocument();
    expect(scanCall).not.toHaveBeenCalled();
  });

  it('scans again when asked', async () => {
    const scanCall = vi.fn(async () => scan());
    const { user } = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': scanCall },
    });
    await screen.findByText(/can be freed/i);
    await user.click(screen.getByRole('button', { name: /scan again/i }));
    await waitFor(() => expect(scanCall).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/can be freed/i)).toBeInTheDocument();
  });

  it('is calm about a project with nothing to clean', async () => {
    renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': async () => scan([]) },
    });
    expect(await screen.findByText('Nothing to clean up')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('reassures the person about what it never touches', async () => {
    renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': async () => scan() },
    });
    await screen.findByText(/can be freed/i);
    expect(screen.getByText(/never touches your source/i)).toBeInTheDocument();
  });
});

describe('when the scan cannot finish', () => {
  it('says what went wrong and tries again on request', async () => {
    let calls = 0;
    const { user } = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: {
        'projectCleanup.scan': async () => {
          calls += 1;
          if (calls === 1) throw new Error('That project no longer exists.');
          return scan();
        },
      },
    });
    expect(await screen.findByText('That project no longer exists.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/can be freed/i)).toBeInTheDocument();
    expect(screen.queryByText('That project no longer exists.')).not.toBeInTheDocument();
  });

  it('does not fall over when the main process answers with nothing', async () => {
    renderWithProviders(<ProjectCleanupTab project={project()} />);
    expect(await screen.findByText(/did not answer/i)).toBeInTheDocument();
  });

  it('stops when told to, and offers to start over', async () => {
    const held = gate<ProjectCleanupScan>();
    const { user, bridge } = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: {
        'projectCleanup.scan': () => held.promise,
        'projectCleanup.cancel': async () => true,
      },
    });
    await screen.findByText(/looking through your project/i);
    const requestId = bridge.$fn('projectCleanup.scan').mock.calls[0]?.[1];
    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(bridge.$fn('projectCleanup.cancel')).toHaveBeenCalledWith(requestId);
    held.reject(new Error('The scan was cancelled.'));
    expect(await screen.findByText('Scan stopped')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /scan project/i })).toBeInTheDocument();
    expect(screen.queryByText(/the scan was cancelled/i)).not.toBeInTheDocument();
  });
});

describe('picking', () => {
  async function ready(over: Record<string, unknown> = {}) {
    const view = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': async () => scan(), ...over },
    });
    await screen.findByText(/can be freed/i);
    return view;
  }

  it('ticks what comes back by itself and leaves the dependencies alone', async () => {
    await ready();
    expect(screen.getByRole('checkbox', { name: 'Select dist' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select .turbo' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Launch film' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select node_modules' })).not.toBeChecked();
    expect(screen.getByText('3 items selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 300 MB' })).toBeInTheDocument();
  });

  it('adds up as the person picks', async () => {
    const { user } = await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Select all in Dependencies' }));
    expect(screen.getByText('4 items selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 1.07 GB' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select dist' }));
    expect(screen.getByRole('button', { name: 'Delete 950 MB' })).toBeInTheDocument();
  });

  it('can pick everything, go back to the safe picks, or pick nothing', async () => {
    const { user } = await ready();
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('4 items selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Safe pick' }));
    expect(screen.getByText('3 items selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it('never picks a folder that is locked', async () => {
    renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: {
        'projectCleanup.scan': async () =>
          scan([
            candidate({
              relPath: 'dist',
              category: 'build',
              bytes: 150 * MB,
              locked: 'Kept in step with the deploy site "Shop".',
            }),
            candidate({ relPath: 'build', category: 'build', bytes: 20 * MB }),
          ]),
      },
    });
    await screen.findByText(/can be freed/i);
    expect(screen.getByRole('checkbox', { name: 'Select dist' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select dist' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select build' })).toBeChecked();
    expect(screen.getByText('1 item selected')).toBeInTheDocument();
    expect(screen.getByText(/deploy site "shop"/i)).toBeInTheDocument();
  });
});

describe('deleting', () => {
  const REMOVED_ALL: CleanupRemoveResult = {
    freedBytes: 300 * MB,
    removed: ['main:dist', 'main:.turbo', 'studio:v1'],
    failed: [],
  };

  async function ready(remove: unknown) {
    const view = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: { 'projectCleanup.scan': async () => scan(), 'projectCleanup.remove': remove },
    });
    await screen.findByText(/can be freed/i);
    return view;
  }

  it('asks first, naming what goes and how to get it back', async () => {
    const { user } = await ready(async () => REMOVED_ALL);
    await user.click(screen.getByRole('checkbox', { name: 'Select all in Dependencies' }));
    await user.click(screen.getByRole('button', { name: 'Delete 1.07 GB' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    const options = confirm.mock.calls[0]?.[0] as {
      title: string;
      variant: string;
      confirmLabel: string;
      warning: string;
      items: { name: string; detail?: string }[];
    };
    expect(options.title).toBe('Delete 4 items?');
    expect(options.variant).toBe('destructive');
    expect(options.confirmLabel).toBe('Delete 1.07 GB');
    expect(options.warning).toContain('pnpm install');
    expect(options.items.map((item) => item.name).sort()).toEqual(
      ['.turbo', 'Launch film', 'dist', 'node_modules'].sort(),
    );
    expect(JSON.stringify(options)).not.toContain('\u2014');
  });

  it('lists a handful and counts the rest when a lot is picked', async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      candidate({ relPath: `pkg${i}/dist`, category: 'build', bytes: (i + 1) * MB }),
    );
    const { user } = renderWithProviders(<ProjectCleanupTab project={project()} />, {
      bridge: {
        'projectCleanup.scan': async () => scan(many),
        'projectCleanup.remove': async () => REMOVED_ALL,
      },
    });
    await screen.findByText(/can be freed/i);
    await user.click(screen.getByRole('button', { name: /^Delete/ }));
    const options = confirm.mock.calls[0]?.[0] as { items: unknown[]; moreCount: number };
    expect(options.items).toHaveLength(6);
    expect(options.moreCount).toBe(3);
  });

  it('does nothing when the person says no', async () => {
    confirm.mockResolvedValue(false);
    const removeCall = vi.fn(async () => REMOVED_ALL);
    const { user } = await ready(removeCall);
    await user.click(screen.getByRole('button', { name: 'Delete 300 MB' }));
    expect(removeCall).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Select dist' })).toBeChecked();
  });

  it('sends only the location and folder, never a path', async () => {
    const removeCall = vi.fn(async () => REMOVED_ALL);
    const { user } = await ready(removeCall);
    await user.click(screen.getByRole('button', { name: 'Delete 300 MB' }));
    await waitFor(() => expect(removeCall).toHaveBeenCalled());
    expect(removeCall).toHaveBeenCalledWith('p1', expect.any(String), [
      { kind: 'folder', locationId: 'main', relPath: 'dist' },
      { kind: 'folder', locationId: 'main', relPath: '.turbo' },
      { kind: 'studio', videoId: 'v1' },
    ]);
    expect(JSON.stringify(removeCall.mock.calls)).not.toContain('C:/work');
  });

  it('shows each one as it goes, and counts them off', async () => {
    const held = gate<CleanupRemoveResult>();
    const { user, bridge } = await ready(() => held.promise);
    await user.click(screen.getByRole('button', { name: 'Delete 300 MB' }));
    await waitFor(() => bridge.$fn('projectCleanup.remove'));
    const requestId = bridge.$fn('projectCleanup.remove').mock.calls[0]?.[1] as string;

    bridge.$emit('projectCleanup.onRemoveEvent', {
      requestId,
      key: 'main:dist',
      status: 'removing',
    });
    const build = screen.getByRole('region', { name: 'Build output' });
    expect(await within(build).findByText('Deleting')).toBeInTheDocument();
    expect(screen.getByText('0 of 3 deleted')).toBeInTheDocument();

    bridge.$emit('projectCleanup.onRemoveEvent', {
      requestId,
      key: 'main:dist',
      status: 'done',
      freedBytes: 150 * MB,
    });
    expect(await screen.findByText(/freed 150 MB/i)).toBeInTheDocument();
    expect(screen.getByText('1 of 3 deleted')).toBeInTheDocument();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();

    held.resolve(REMOVED_ALL);
    await waitFor(() => expect(screen.queryByText('1 of 3 deleted')).not.toBeInTheDocument());
  });

  it('takes the deleted ones off the list, lowers the numbers and says what was freed', async () => {
    const { user } = await ready(async () => REMOVED_ALL);
    await user.click(screen.getByRole('button', { name: 'Delete 300 MB' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/freed about 300 MB/i)),
    );
    expect(screen.queryByRole('checkbox', { name: 'Select dist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select .turbo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Studio render cache' })).not.toBeInTheDocument();
    // The dependencies are left: 800 MB.
    expect(screen.getByRole('checkbox', { name: 'Select node_modules' })).toBeInTheDocument();
    expect(screen.getByText(/can be freed/i).nextElementSibling).toHaveTextContent('800 MB');
    expect(useProjectCleanupStore.getState().summaries.p1?.reclaimableBytes).toBe(800 * MB);
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it('keeps what could not be deleted, with the reason, and tries it again without asking twice', async () => {
    const removeCall = vi
      .fn()
      .mockResolvedValueOnce({
        freedBytes: 250 * MB,
        removed: ['main:dist', 'studio:v1'],
        failed: [
          { key: 'main:.turbo', error: 'Something is still using it. Stop the dev server.' },
        ],
      } satisfies CleanupRemoveResult)
      .mockResolvedValueOnce({
        freedBytes: 50 * MB,
        removed: ['main:.turbo'],
        failed: [],
      } satisfies CleanupRemoveResult);
    const { user } = await ready(removeCall);
    await user.click(screen.getByRole('button', { name: 'Delete 300 MB' }));

    expect(await screen.findByText(/something is still using it/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Select dist' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select .turbo' })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/freed about 250 MB/i));

    await user.click(screen.getByRole('button', { name: /try again.*\.turbo/i }));
    await waitFor(() => expect(removeCall).toHaveBeenCalledTimes(2));
    expect(removeCall.mock.calls[1]?.[2]).toEqual([
      { kind: 'folder', locationId: 'main', relPath: '.turbo' },
    ]);
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: 'Select .turbo' })).not.toBeInTheDocument(),
    );
  });

  it('says so when nothing at all could be deleted', async () => {
    const { user } = await ready(async () => ({
      freedBytes: 0,
      removed: [],
      failed: [
        { key: 'main:dist', error: 'Could not delete it.' },
        { key: 'main:.turbo', error: 'Could not delete it.' },
        { key: 'studio:v1', error: 'This video is rendering. Try again when the render is done.' },
      ],
    }));
    await user.click(screen.getByRole('button', { name: 'Delete 300 MB' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    const studio = screen.getByRole('region', { name: 'Studio render cache' });
    expect(within(studio).getByText(/video is rendering/i)).toBeInTheDocument();
  });

  it('reports a failed call as an error and lets the person pick again', async () => {
    const { user } = await ready(async () => {
      throw new Error('Clean-up is already working on this project.');
    });
    await user.click(screen.getByRole('button', { name: 'Delete 300 MB' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Clean-up is already working on this project.'),
    );
    expect(screen.getByRole('button', { name: 'Delete 300 MB' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Select dist' })).toBeEnabled();
  });
});
