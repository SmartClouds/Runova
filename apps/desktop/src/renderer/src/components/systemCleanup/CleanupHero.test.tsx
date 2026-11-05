import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Overview } from '@/lib/systemCleanup/view';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CleanupHero, type CleanupHeroProps } from './CleanupHero';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function overview(over: Partial<Overview> = {}): Overview {
  return {
    totalBytes: 4 * GB,
    totalFiles: 120_000,
    packageCount: 1902,
    reclaimableBytes: 1.5 * GB,
    cachesFound: 3,
    remembered: false,
    scannedAt: null,
    parts: [
      { id: 'nuget', label: 'NuGet', bytes: 3 * GB },
      { id: 'bun', label: 'Bun', bytes: 800 * MB },
      { id: 'npm', label: 'npm', bytes: 200 * MB },
    ],
    volume: { mount: 'C:', totalBytes: 453 * GB, freeBytes: 31 * GB, cacheBytes: 4 * GB },
    ...over,
  };
}

function hero(over: Partial<CleanupHeroProps> = {}): CleanupHeroProps {
  return {
    phase: 'ready',
    overview: overview(),
    keep: 1,
    scan: null,
    clean: null,
    now: 1_000_000,
    onKeepChange: vi.fn(),
    onScan: vi.fn(),
    onCancel: vi.fn(),
    onCleanOld: vi.fn(),
    ...over,
  };
}

describe('CleanupHero, before any scan', () => {
  it('invites the first scan and says what it does and does not do', async () => {
    const p = hero({
      phase: 'empty',
      overview: overview({ totalBytes: 0, parts: [], volume: null, cachesFound: 0 }),
    });
    const { user } = renderWithProviders(<CleanupHero {...p} />);
    expect(screen.getByText(/see what your tools are keeping/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing in your projects is touched/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /find caches/i }));
    expect(p.onScan).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /clean old versions/i })).not.toBeInTheDocument();
  });
});

describe('CleanupHero, while scanning', () => {
  const scanning = hero({
    phase: 'scanning',
    scan: { done: 2, total: 9, bytes: 12.4 * GB, files: 83_000 },
  });

  it('says how far along it is, with a progress bar that says so in words', () => {
    renderWithProviders(<CleanupHero {...scanning} />);
    expect(screen.getByText(/looking through your caches/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/2 of 9 caches read/i);
    const bar = screen.getByRole('progressbar', { name: /scanning caches/i });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '9');
  });

  it('shows what has been found so far, counting up', () => {
    renderWithProviders(<CleanupHero {...scanning} />);
    expect(screen.getByText('12.4 GB')).toBeInTheDocument();
    expect(screen.getByText(/found so far/i)).toBeInTheDocument();
    expect(screen.getByText(/83,000 files/)).toBeInTheDocument();
  });

  it('can be stopped, and offers nothing else', async () => {
    const { user } = renderWithProviders(<CleanupHero {...scanning} />);
    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(scanning.onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: /clean old versions|scan again/i }),
    ).not.toBeInTheDocument();
  });
});

describe('CleanupHero, when the scan is done', () => {
  it('says how much can be freed, and how much the caches take in all', () => {
    renderWithProviders(<CleanupHero {...hero()} />);
    expect(screen.getByText(/can be freed/i)).toBeInTheDocument();
    expect(screen.getByText('1.50 GB')).toBeInTheDocument();
    expect(screen.getByText(/4\.00 GB in 3 caches, 1,902 packages/i)).toBeInTheDocument();
  });

  it('says what "old" means for the number of versions kept', () => {
    const { rerender } = renderWithProviders(<CleanupHero {...hero({ keep: 1 })} />);
    expect(screen.getByText(/all but the newest version of each package/i)).toBeInTheDocument();
    rerender(<CleanupHero {...hero({ keep: 2 })} />);
    expect(screen.getByText(/all but the newest 2 versions of each package/i)).toBeInTheDocument();
  });

  it('lets the person choose how many versions to keep', async () => {
    const p = hero();
    const { user } = renderWithProviders(<CleanupHero {...p} />);
    const group = screen.getByRole('group', { name: /versions to keep/i });
    expect(within(group).getByRole('button', { name: '1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(group).getByRole('button', { name: '3' }));
    expect(p.onKeepChange).toHaveBeenCalledWith(3);
  });

  it('draws where the space goes as a bar that says it in words, and a key with sizes', () => {
    renderWithProviders(<CleanupHero {...hero()} />);
    const bar = screen.getByRole('img', { name: /where the space goes/i });
    expect(bar).toHaveAccessibleName(/NuGet 3\.00 GB/);
    expect(bar).toHaveAccessibleName(/Bun 800 MB/);
    const key = screen.getByRole('list', { name: /space by cache/i });
    expect(
      within(key)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['NuGet3.00 GB', 'Bun800 MB', 'npm200 MB']);
  });

  it('says how much of the disk the caches use, and how much is free', () => {
    renderWithProviders(<CleanupHero {...hero()} />);
    expect(screen.getByText(/caches use 4\.00 GB of the 453 GB on C:/i)).toBeInTheDocument();
    // One sentence, with no stray full stop after the drive's colon.
    expect(screen.getByText(/on C:, and 31\.0 GB is free\.$/i)).toBeInTheDocument();
    expect(screen.getByText(/31\.0 GB is free/i)).toBeInTheDocument();
  });

  it('leaves the disk out when it could not be read', () => {
    renderWithProviders(<CleanupHero {...hero({ overview: overview({ volume: null }) })} />);
    expect(screen.queryByText(/caches use/i)).not.toBeInTheDocument();
  });

  it('offers to clean old versions and to scan again', async () => {
    const p = hero();
    const { user } = renderWithProviders(<CleanupHero {...p} />);
    await user.click(screen.getByRole('button', { name: /clean old versions/i }));
    await user.click(screen.getByRole('button', { name: /scan again/i }));
    expect(p.onCleanOld).toHaveBeenCalledTimes(1);
    expect(p.onScan).toHaveBeenCalledTimes(1);
  });

  it('says everything is tidy when there is nothing old, and does not offer to clean it', () => {
    renderWithProviders(<CleanupHero {...hero({ overview: overview({ reclaimableBytes: 0 }) })} />);
    expect(screen.getByText(/everything is tidy/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clean old versions/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /scan again/i })).toBeInTheDocument();
  });

  it('says plainly when the figures are from an earlier scan', () => {
    renderWithProviders(
      <CleanupHero
        {...hero({
          overview: overview({ remembered: true, scannedAt: 1_000_000 - 2 * 86_400_000 }),
        })}
      />,
    );
    expect(screen.getByText(/from your last scan, 2d ago/i)).toBeInTheDocument();
  });

  it('says when the scan was cut short and nothing was found', () => {
    renderWithProviders(
      <CleanupHero
        {...hero({
          overview: overview({
            cachesFound: 0,
            totalBytes: 0,
            reclaimableBytes: 0,
            parts: [],
            volume: null,
          }),
        })}
      />,
    );
    expect(screen.getByText(/nothing found/i)).toBeInTheDocument();
  });
});

describe('CleanupHero, while cleaning', () => {
  const cleaning = hero({
    phase: 'cleaning',
    clean: { label: 'NuGet', processed: 3, total: 10, freedBytes: 2.5 * GB },
  });

  it('says what is being cleaned, how far along it is, and what has been freed', () => {
    renderWithProviders(<CleanupHero {...cleaning} />);
    expect(screen.getByText(/cleaning nuget/i)).toBeInTheDocument();
    expect(screen.getByText('2.50 GB')).toBeInTheDocument();
    expect(screen.getByText(/freed so far/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/3 of 10/);
    expect(screen.getByRole('progressbar', { name: /cleaning/i })).toHaveAttribute(
      'aria-valuenow',
      '3',
    );
  });

  it('can be cancelled', async () => {
    const { user } = renderWithProviders(<CleanupHero {...cleaning} />);
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(cleaning.onCancel).toHaveBeenCalledTimes(1);
  });

  it('copes with a command that reports no steps', () => {
    renderWithProviders(
      <CleanupHero
        {...hero({
          phase: 'cleaning',
          clean: { label: 'npm', processed: 0, total: 1, freedBytes: 0 },
        })}
      />,
    );
    expect(screen.getByRole('progressbar', { name: /cleaning/i })).toBeInTheDocument();
  });
});
