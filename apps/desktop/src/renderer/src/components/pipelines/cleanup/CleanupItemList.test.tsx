import type { RunnerCleanupGroup } from '@shared/apiTypes';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CleanupItemList } from './CleanupItemList';

const GB = 1024 ** 3;

const groups: RunnerCleanupGroup[] = [
  {
    id: 'r0',
    kind: 'runner',
    title: 'build-01',
    subtitle: 'acme/web · /home/ci/actions-runner/build-01',
    status: 'busy',
    items: [
      {
        id: 'r0-logs',
        label: 'Runner logs older than 7 days',
        why: 'Diagnostic logs.',
        bytes: GB,
        risk: 'safe',
        picked: true,
      },
      {
        id: 'r0-checkouts',
        label: 'Job checkouts (2 repos)',
        why: 'Working copies.',
        bytes: 4 * GB,
        risk: 'slows',
        picked: false,
        disabledReason: 'A job is running on this runner right now',
      },
      {
        id: 'r0-actions',
        label: 'Downloaded actions',
        why: 'Copies of actions.',
        bytes: 2 * GB,
        risk: 'slows',
        picked: false,
      },
    ],
  },
  {
    id: 'abandoned',
    kind: 'abandoned',
    title: 'Runners that are gone',
    items: [
      {
        id: 'gone-1',
        label: 'old-box',
        why: 'No longer registered.',
        bytes: 3 * GB,
        risk: 'careful',
        picked: false,
      },
    ],
  },
];

function renderList(props: Partial<React.ComponentProps<typeof CleanupItemList>> = {}) {
  const onPicksChange = vi.fn();
  render(
    <TooltipProvider>
      <CleanupItemList
        groups={groups}
        picks={new Set(['r0-logs'])}
        onPicksChange={onPicksChange}
        outcomes={{}}
        running={new Set()}
        locked={false}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onPicksChange };
}

describe('CleanupItemList', () => {
  it('shows each group with its status and total, and each item with its size', () => {
    renderList();
    const runner = screen.getByRole('group', { name: 'build-01' });
    expect(within(runner).getByText('Busy')).toBeInTheDocument();
    expect(within(runner).getByText('7.00 GB')).toBeInTheDocument();
    expect(within(runner).getByText('Runner logs older than 7 days')).toBeInTheDocument();
    expect(within(runner).getByText('1.00 GB')).toBeInTheDocument();
    expect(
      within(runner).getByText('acme/web · /home/ci/actions-runner/build-01'),
    ).toBeInTheDocument();
  });

  it('picks and unpicks one item', () => {
    const { onPicksChange } = renderList();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Downloaded actions' }));
    expect([...onPicksChange.mock.calls[0][0]].sort()).toEqual(['r0-actions', 'r0-logs']);
  });

  it('picks every usable item of a group from its own checkbox', () => {
    const { onPicksChange } = renderList();
    const all = screen.getByRole('checkbox', { name: 'Pick everything in build-01' });
    expect(all).toHaveAttribute('data-state', 'indeterminate');
    fireEvent.click(all);
    expect([...onPicksChange.mock.calls[0][0]].sort()).toEqual(['r0-actions', 'r0-logs']);
  });

  it('turns off an item that cannot go now and says why', () => {
    renderList();
    expect(screen.getByRole('checkbox', { name: 'Job checkouts (2 repos)' })).toBeDisabled();
    expect(screen.getByText('A job is running on this runner right now')).toBeInTheDocument();
  });

  it('marks what each choice costs', () => {
    renderList();
    expect(screen.getAllByText('Downloads again').length).toBeGreaterThan(0);
    expect(screen.getByText('Removes the runner')).toBeInTheDocument();
  });

  it('shows how each item went during and after a cleanup', () => {
    renderList({
      locked: true,
      running: new Set(['r0-actions']),
      outcomes: {
        'r0-logs': { id: 'r0-logs', status: 'done', freedBytes: GB },
        'gone-1': { id: 'gone-1', status: 'failed', freedBytes: 0, error: 'Needs sudo' },
      },
    });
    expect(screen.getByText('Freed 1.00 GB')).toBeInTheDocument();
    expect(screen.getByText('Needs sudo')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Cleaning Downloaded actions' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Downloaded actions' })).toBeDisabled();
  });
});
