import type {
  CleanupCandidate,
  CleanupLocation,
  ProjectCleanupScan,
} from '@shared/projectCleanupTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { groupRows, rowsFromScan } from '@/lib/projectCleanup/selection';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CleanupGroupList, type CleanupGroupListProps, type RowStatus } from './CleanupGroupList';

const MB = 1024 ** 2;
const NOW = 1_700_000_000_000;

function candidate(over: Partial<CleanupCandidate>): CleanupCandidate {
  const relPath = over.relPath ?? 'node_modules';
  const locationId = over.locationId ?? 'main';
  return {
    id: `${locationId}:${relPath}`,
    locationId,
    relPath,
    name: relPath.split('/').at(-1) ?? relPath,
    category: 'dependencies',
    bytes: 100 * MB,
    sharedBytes: 0,
    files: 1200,
    modifiedAt: NOW - 3 * 3600_000,
    restore: { label: 'Comes back when you reinstall the dependencies.', command: 'pnpm install' },
    locked: null,
    ...over,
  };
}

function location(
  candidates: CleanupCandidate[],
  over: Partial<CleanupLocation> = {},
): CleanupLocation {
  return {
    id: 'main',
    label: 'Project folder',
    path: 'C:/shop',
    branch: null,
    isMain: true,
    totalBytes: 1000 * MB,
    gitBytes: 0,
    unreadable: 0,
    candidates,
    ...over,
  };
}

function scanOf(locations: CleanupLocation[], studio: ProjectCleanupScan['studio'] = []) {
  return { projectId: 'p1', scannedAt: NOW, locations, studio } satisfies ProjectCleanupScan;
}

const DEFAULT_SCAN = scanOf(
  [
    location([
      candidate({ relPath: 'node_modules', bytes: 800 * MB }),
      candidate({ relPath: 'apps/web/node_modules', bytes: 200 * MB }),
      candidate({
        relPath: 'dist',
        category: 'build',
        bytes: 40 * MB,
        files: 12,
        restore: { label: 'Comes back the next time you build the project.', command: null },
      }),
    ]),
  ],
  [{ videoId: 'v1', title: 'Launch film', bytes: 60 * MB, busy: false }],
);

function props(
  over: Partial<CleanupGroupListProps> = {},
  scan = DEFAULT_SCAN,
): CleanupGroupListProps {
  const selected = over.selected ?? new Set<string>();
  return {
    groups: groupRows(rowsFromScan(scan), selected),
    selected,
    statuses: {},
    disabled: false,
    now: NOW,
    onToggleRow: vi.fn(),
    onToggleGroup: vi.fn(),
    onRetry: vi.fn(),
    ...over,
  };
}

describe('CleanupGroupList', () => {
  it('shows each group with what it is, how many it holds and how much it could free', () => {
    renderWithProviders(<CleanupGroupList {...props()} />);
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names).toEqual(['Build output', 'Dependencies', 'Studio render cache']);

    const deps = screen.getByRole('region', { name: 'Dependencies' });
    expect(within(deps).getByText(/installed again by your package manager/i)).toBeInTheDocument();
    expect(within(deps).getByText('2')).toBeInTheDocument();
    // 800 MB and 200 MB, which formatBytes writes as a gigabyte once it passes 999.5 MB.
    expect(within(deps).getByText('0.98 GB')).toBeInTheDocument();
    expect(within(deps).getByText('to free')).toBeInTheDocument();
  });

  it('shows the folder with its parent path dimmed and its size on the right', () => {
    renderWithProviders(<CleanupGroupList {...props()} />);
    const deps = screen.getByRole('region', { name: 'Dependencies' });
    const nested = within(deps).getByText('apps/web/');
    expect(nested.nextElementSibling).toHaveTextContent('node_modules');
    expect(within(deps).getByText('800 MB')).toBeInTheDocument();
    expect(within(deps).getByText('200 MB')).toBeInTheDocument();
  });

  it('puts the biggest first and draws each size against the biggest', () => {
    renderWithProviders(<CleanupGroupList {...props()} />);
    const deps = screen.getByRole('region', { name: 'Dependencies' });
    const bars = within(deps).getAllByTestId('size-bar');
    expect(bars.map((bar) => bar.style.width)).toEqual(['100%', '25%']);
  });

  it('says how many files and how long ago the folder last changed', () => {
    renderWithProviders(<CleanupGroupList {...props()} />);
    const build = screen.getByRole('region', { name: 'Build output' });
    expect(within(build).getByText(/12 files/)).toBeInTheDocument();
    expect(within(build).getByText(/changed 3h ago/i)).toBeInTheDocument();
  });

  it('says "1 file", not "1 files"', () => {
    const scan = scanOf([location([candidate({ relPath: 'dist', category: 'build', files: 1 })])]);
    renderWithProviders(<CleanupGroupList {...props({}, scan)} />);
    expect(screen.getByText('1 file')).toBeInTheDocument();
    expect(screen.queryByText('1 files')).not.toBeInTheDocument();
  });

  it('names the command that brings a folder back, and explains it on hover', async () => {
    const { user } = renderWithProviders(<CleanupGroupList {...props()} />);
    const deps = screen.getByRole('region', { name: 'Dependencies' });
    const chips = within(deps).getAllByText('pnpm install');
    expect(chips).toHaveLength(2);
    await user.hover(chips[0] as HTMLElement);
    expect(
      (await screen.findAllByText('Comes back when you reinstall the dependencies.')).length,
    ).toBeGreaterThan(0);
    const build = screen.getByRole('region', { name: 'Build output' });
    expect(within(build).queryByText(/install/)).not.toBeInTheDocument();
  });

  it('names the worktree a folder belongs to', () => {
    const scan = scanOf([
      location([candidate({ relPath: 'node_modules' })]),
      location([candidate({ locationId: 'wt1', relPath: 'node_modules' })], {
        id: 'wt1',
        label: 'feature/login',
        isMain: false,
      }),
    ]);
    renderWithProviders(<CleanupGroupList {...props({}, scan)} />);
    expect(screen.getByText('feature/login')).toBeInTheDocument();
  });

  it('shows a Studio video by its title', () => {
    renderWithProviders(<CleanupGroupList {...props()} />);
    const studio = screen.getByRole('region', { name: 'Studio render cache' });
    const row = within(studio).getByRole('listitem');
    expect(within(row).getByText('Launch film')).toBeInTheDocument();
    expect(within(row).getByText('Render cache')).toBeInTheDocument();
    expect(within(row).getByText('60.0 MB')).toBeInTheDocument();
  });

  it('says plainly when deleting frees less than the folder shows', () => {
    const scan = scanOf([location([candidate({ bytes: 500 * MB, sharedBytes: 400 * MB })])]);
    renderWithProviders(<CleanupGroupList {...props({}, scan)} />);
    expect(screen.getByText(/frees about 100 MB/i)).toBeInTheDocument();
  });
});

describe('picking', () => {
  it('ticks the rows that are picked and tells the page when one is clicked', async () => {
    const p = props({ selected: new Set(['main:dist']) });
    const { user } = renderWithProviders(<CleanupGroupList {...p} />);
    expect(screen.getByRole('checkbox', { name: 'Select dist' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select node_modules' })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Select node_modules' }));
    expect(p.onToggleRow).toHaveBeenCalledWith('main:node_modules');
  });

  it('lets a click on the name pick the row as well', async () => {
    const p = props();
    const { user } = renderWithProviders(<CleanupGroupList {...p} />);
    await user.click(screen.getByText('dist'));
    expect(p.onToggleRow).toHaveBeenCalledWith('main:dist');
  });

  it('shows a group as ticked when all of it is picked', () => {
    const all = props({ selected: new Set(['main:node_modules', 'main:apps/web/node_modules']) });
    renderWithProviders(<CleanupGroupList {...all} />);
    expect(screen.getByRole('checkbox', { name: 'Select all in Dependencies' })).toBeChecked();
  });

  it('shows a group as half ticked when only some of it is picked', () => {
    const some = props({ selected: new Set(['main:node_modules']) });
    renderWithProviders(<CleanupGroupList {...some} />);
    expect(screen.getByRole('checkbox', { name: 'Select all in Dependencies' })).toHaveAttribute(
      'aria-checked',
      'mixed',
    );
  });

  it('picks the whole group when its checkbox is clicked', async () => {
    const none = props();
    const { user } = renderWithProviders(<CleanupGroupList {...none} />);
    const box = screen.getByRole('checkbox', { name: 'Select all in Dependencies' });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(none.onToggleGroup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(none.onToggleGroup).mock.calls[0]?.[0]).toMatchObject({ id: 'dependencies' });
  });

  it('turns everything off while a scan or a removal is running', () => {
    renderWithProviders(<CleanupGroupList {...props({ disabled: true })} />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });
});

describe('locked rows', () => {
  const locked = scanOf([
    location([
      candidate({
        relPath: 'site/dist',
        category: 'build',
        locked: 'Kept in step with the deploy site "Shop".',
      }),
      candidate({ relPath: 'dist', category: 'build' }),
    ]),
  ]);

  it('cannot be picked, and say why', () => {
    renderWithProviders(<CleanupGroupList {...props({}, locked)} />);
    expect(screen.getByRole('checkbox', { name: 'Select site/dist' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select dist' })).toBeEnabled();
    expect(screen.getByText(/kept in step with the deploy site "Shop"/i)).toBeInTheDocument();
  });

  it('leave the group checkbox to the rows that can be picked', () => {
    const p = props({ selected: new Set(['main:dist']) }, locked);
    renderWithProviders(<CleanupGroupList {...p} />);
    expect(screen.getByRole('checkbox', { name: 'Select all in Build output' })).toBeChecked();
  });

  it('disable the group checkbox when nothing in the group can be picked', () => {
    const allLocked = scanOf([
      location([candidate({ category: 'build', relPath: 'dist', locked: 'Deployed.' })]),
    ]);
    renderWithProviders(<CleanupGroupList {...props({}, allLocked)} />);
    expect(screen.getByRole('checkbox', { name: 'Select all in Build output' })).toBeDisabled();
  });
});

describe('while deleting', () => {
  const statuses = (map: Record<string, RowStatus>) => map;

  it('shows a row being deleted, one that is done and one that failed', () => {
    const p = props({
      selected: new Set(['main:dist', 'main:node_modules', 'main:apps/web/node_modules']),
      disabled: true,
      statuses: statuses({
        'main:dist': { status: 'done', freedBytes: 40 * MB },
        'main:node_modules': { status: 'removing' },
        'main:apps/web/node_modules': {
          status: 'failed',
          error: 'Something is still using it. Stop any dev server, then try again.',
        },
      }),
    });
    renderWithProviders(<CleanupGroupList {...p} />);
    expect(screen.getByText(/freed 40\.0 MB/i)).toBeInTheDocument();
    expect(screen.getByText(/deleting/i)).toBeInTheDocument();
    expect(screen.getByText(/something is still using it/i)).toBeInTheDocument();
  });

  it('offers to try a failed one again', async () => {
    const p = props({
      statuses: { 'main:dist': { status: 'failed', error: 'Could not delete it.' } },
    });
    const { user } = renderWithProviders(<CleanupGroupList {...p} />);
    await user.click(screen.getByRole('button', { name: /try again.*dist/i }));
    expect(p.onRetry).toHaveBeenCalledWith('main:dist');
  });

  it('tells a screen reader what happened to a row without it having to look', () => {
    const p = props({
      statuses: { 'main:dist': { status: 'failed', error: 'Could not delete it.' } },
    });
    renderWithProviders(<CleanupGroupList {...p} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not delete it.');
  });
});
