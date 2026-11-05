import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useProjectCleanupStore } from '@/stores/projectCleanupStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ProjectStorageChip } from './ProjectStorageChip';

const GB = 1024 ** 3;

function know(projectId: string, totalBytes: number, reclaimableBytes: number, ageMs = 5 * 60_000) {
  useProjectCleanupStore.setState({
    summaries: {
      [projectId]: { scannedAt: Date.now() - ageMs, totalBytes, reclaimableBytes },
    },
  });
}

describe('ProjectStorageChip', () => {
  it('offers to find out when the size is not known yet', async () => {
    const onOpen = vi.fn();
    const { user } = renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={onOpen} />);
    await user.click(
      screen.getByRole('button', { name: /check how much space this project uses/i }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows what the project uses and how much of it can go', () => {
    know('p1', 3.1 * GB, 1.2 * GB);
    renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={vi.fn()} />);
    expect(screen.getByText('3.10 GB')).toBeInTheDocument();
    expect(screen.getByText('1.20 GB to free')).toBeInTheDocument();
  });

  it('says it all in the button name for a screen reader', () => {
    know('p1', 3.1 * GB, 1.2 * GB);
    renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', {
        name: 'This project uses 3.10 GB, and 1.20 GB of it can be freed. Open Cleanup.',
      }),
    ).toBeInTheDocument();
  });

  it('shows only the size when there is nothing to free', () => {
    know('p1', 0.4 * GB, 0);
    renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={vi.fn()} />);
    expect(screen.getByText('410 MB')).toBeInTheDocument();
    expect(screen.queryByText(/to free/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'This project uses 410 MB, and nothing in it can be freed. Open Cleanup.',
      }),
    ).toBeInTheDocument();
  });

  it('says how old the number is when asked', async () => {
    know('p1', 3.1 * GB, 1.2 * GB, 3 * 3600_000);
    const { user } = renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={vi.fn()} />);
    await user.hover(screen.getByRole('button', { name: /this project uses/i }));
    expect((await screen.findAllByText(/scanned 3h ago/i)).length).toBeGreaterThan(0);
  });

  it('opens the project without also opening the card around it', async () => {
    know('p1', 3.1 * GB, 1.2 * GB);
    const onOpen = vi.fn();
    const onCard = vi.fn();
    const { user } = renderWithProviders(
      <div onClick={onCard}>
        <ProjectStorageChip projectId="p1" onOpen={onOpen} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /this project uses/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onCard).not.toHaveBeenCalled();
  });

  it('shows that it is looking while a scan of all projects is on this one', () => {
    useProjectCleanupStore.setState({
      bulk: { running: true, done: 0, total: 3, current: 'p1', failed: 0 },
    });
    renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={vi.fn()} />);
    expect(screen.getByText(/checking/i)).toBeInTheDocument();
  });

  it('never repeats a project name, so it does not compete with the card for that name', () => {
    // A name-matching locator or a voice command for the project must find one button, the
    // card's own. A label that carried the name made two, and broke the projects e2e spec.
    for (const [total, free] of [
      [3.1 * GB, 1.2 * GB],
      [0.4 * GB, 0],
    ] as const) {
      know('p1', total, free);
      const { unmount } = renderWithProviders(
        <ProjectStorageChip projectId="p1" onOpen={vi.fn()} />,
      );
      const label = screen.getByRole('button').getAttribute('aria-label') ?? '';
      expect(label).not.toMatch(/apollo|lantern/i);
      unmount();
    }
    useProjectCleanupStore.setState({ summaries: {} });
    renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={vi.fn()} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Check how much space this project uses',
    );
  });

  it('keeps the projects apart', () => {
    know('p2', 9 * GB, 5 * GB);
    renderWithProviders(<ProjectStorageChip projectId="p1" onOpen={vi.fn()} />);
    expect(screen.queryByText('9.00 GB')).not.toBeInTheDocument();
    expect(screen.getByText(/check size/i)).toBeInTheDocument();
  });
});
