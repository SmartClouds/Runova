import type { ProjectCleanupScan } from '@shared/projectCleanupTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectCleanupStore } from '@/stores/projectCleanupStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { ScanAllButton } = await import('./ScanAllButton');

const MB = 1024 ** 2;

function scanOf(projectId: string, freeMb: number): ProjectCleanupScan {
  return {
    projectId,
    scannedAt: Date.now(),
    studio: [],
    locations: [
      {
        id: 'main',
        label: 'Project folder',
        path: `C:/${projectId}`,
        branch: null,
        isMain: true,
        totalBytes: 1000 * MB,
        gitBytes: 0,
        unreadable: 0,
        candidates: [
          {
            id: 'main:dist',
            locationId: 'main',
            relPath: 'dist',
            name: 'dist',
            category: 'build',
            bytes: freeMb * MB,
            sharedBytes: 0,
            files: 1,
            modifiedAt: 0,
            restore: { label: 'x', command: null },
            locked: null,
          },
        ],
      },
    ],
  };
}

const FREE: Record<string, number> = { p1: 300, p2: 200, p3: 100 };

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
});

describe('ScanAllButton', () => {
  it('has nothing to do without projects', () => {
    renderWithProviders(<ScanAllButton projectIds={[]} />);
    expect(screen.getByRole('button', { name: /check sizes/i })).toBeDisabled();
  });

  it('checks every project and says how much could be freed in all', async () => {
    const scan = vi.fn(async (id: string) => scanOf(id, FREE[id] ?? 0));
    const { user } = renderWithProviders(<ScanAllButton projectIds={['p1', 'p2']} />, {
      bridge: { 'projectCleanup.scan': scan },
    });
    await user.click(screen.getByRole('button', { name: /check sizes/i }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Checked 2 projects. About 500 MB can be freed.'),
    );
    expect(scan).toHaveBeenCalledTimes(2);
    expect(Object.keys(useProjectCleanupStore.getState().summaries).sort()).toEqual(['p1', 'p2']);
    expect(screen.getByRole('button', { name: /check sizes/i })).toBeEnabled();
  });

  it('says "1 project" for one', async () => {
    const { user } = renderWithProviders(<ScanAllButton projectIds={['p1']} />, {
      bridge: { 'projectCleanup.scan': async (id: string) => scanOf(id, 300) },
    });
    await user.click(screen.getByRole('button', { name: /check sizes/i }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Checked 1 project. About 300 MB can be freed.'),
    );
  });

  it('shows how far along it is, and can be stopped', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = vi.fn(async (id: string) => {
      await held;
      return scanOf(id, FREE[id] ?? 0);
    });
    const { user, bridge } = renderWithProviders(
      <ScanAllButton projectIds={['p1', 'p2', 'p3']} />,
      { bridge: { 'projectCleanup.scan': scan, 'projectCleanup.cancel': async () => true } },
    );
    await user.click(screen.getByRole('button', { name: /check sizes/i }));
    expect(await screen.findByText('Checking 1 of 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check sizes/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /stop checking/i }));
    expect(bridge.$fn('projectCleanup.cancel')).toHaveBeenCalled();
    release();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /check sizes/i })).toBeInTheDocument(),
    );
    expect(scan).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('mentions the projects it could not check', async () => {
    const { user } = renderWithProviders(<ScanAllButton projectIds={['p1', 'gone']} />, {
      bridge: {
        'projectCleanup.scan': async (id: string) => {
          if (id === 'gone') throw new Error('That project no longer exists.');
          return scanOf(id, 300);
        },
      },
    });
    await user.click(screen.getByRole('button', { name: /check sizes/i }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Checked 1 project. About 300 MB can be freed. 1 could not be checked.',
      ),
    );
  });
});
