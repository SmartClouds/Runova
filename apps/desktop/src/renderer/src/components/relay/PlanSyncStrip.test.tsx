import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { PlanSyncStrip } from './PlanSyncStrip';
import { RelayOverview } from './PlanViews';
import { board } from './testing/fixtures';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

function status(ahead: number, behind: number, hasRemote = true) {
  return {
    isRepo: true,
    branch: 'main',
    defaultBranch: 'main',
    ahead,
    behind,
    hasRemote,
    files: [],
    branches: [],
  };
}

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('PlanSyncStrip', () => {
  it('offers Pull when the remote has new commits, and Push for plan commits not pushed', async () => {
    const { user, bridge } = renderWithProviders(<PlanSyncStrip projectId="p1" />, {
      bridge: {
        'git.status': status(2, 3),
        'git.pull': async () => ({ ok: true, message: 'ok' }),
        'git.push': async () => ({ ok: true, message: 'ok' }),
      },
    });
    const strip = await screen.findByRole('status', { name: 'Plan sync' });
    expect(strip).toHaveTextContent('3 new commits on main');
    expect(strip).toHaveTextContent('2 commits not pushed');
    await user.click(screen.getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(bridge.$fn('git.pull')).toHaveBeenCalledWith('p1'));
    expect(toast.success).toHaveBeenCalledWith('Pulled the latest plan');
    await user.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() => expect(bridge.$fn('git.push')).toHaveBeenCalledWith('p1'));
  });

  it('says it is up to date, checks the remote on request, and hides without a remote', async () => {
    const { user, bridge, unmount } = renderWithProviders(<PlanSyncStrip projectId="p1" />, {
      bridge: {
        'git.status': status(0, 0),
        'git.fetch': async () => ({ ok: false, message: 'offline' }),
      },
    });
    expect(await screen.findByText('Up to date with the remote')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check the remote for plan changes' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not check', { description: 'offline' }),
    );
    expect(bridge.$fn('git.fetch')).toHaveBeenCalledWith('p1');
    unmount();
    renderWithProviders(<PlanSyncStrip projectId="p2" />, {
      bridge: { 'git.status': status(0, 0, false) },
    });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Plan sync' })).toBeNull());
  });
});

describe('duplicate ids on the overview', () => {
  it('gives the second file the next free id', async () => {
    const { user, bridge } = renderWithProviders(
      <RelayOverview
        board={board()}
        pack={{
          plan: null,
          items: { milestone: [], decision: [], workaround: [], risk: [], question: [] },
          duplicates: [{ id: 'T002', files: ['T002-a.md', 'T002-b.md'] }],
        }}
        onSelectTask={vi.fn()}
        onEditPlan={vi.fn()}
      />,
      { bridge: { 'relay.revisits': [], 'relay.renumber': async () => 'T009' } },
    );
    await user.click(screen.getByRole('button', { name: 'Give T002-b.md a new id' }));
    await waitFor(() =>
      expect(bridge.$fn('relay.renumber')).toHaveBeenCalledWith('p1', 'T002-b.md'),
    );
    expect(toast.success).toHaveBeenCalledWith('T002-b.md is T009 now', expect.anything());
  });
});
