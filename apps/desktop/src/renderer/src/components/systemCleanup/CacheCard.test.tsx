import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CardModel } from '@/lib/systemCleanup/view';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CacheCard, type CacheCardProps } from './CacheCard';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function card(over: Partial<CardModel> = {}): CardModel {
  return {
    id: 'nuget',
    label: 'NuGet',
    tagline: '.NET packages',
    kind: 'versioned',
    state: 'live',
    bytes: 4 * GB,
    files: 120_000,
    packageCount: 1902,
    reclaimableBytes: 1.5 * GB,
    root: 'C:\\Users\\me\\.nuget\\packages',
    scannedAt: null,
    needsScan: false,
    note: null,
    actions: { review: true, cleanOld: true, clearAll: true, tool: null },
    ...over,
  };
}

function props(over: Partial<CacheCardProps> = {}): CacheCardProps {
  return {
    card: card(),
    biggest: 8 * GB,
    busy: false,
    now: 1_000_000,
    onReview: vi.fn(),
    onCleanOld: vi.fn(),
    onClearAll: vi.fn(),
    onTool: vi.fn(),
    onScan: vi.fn(),
    onReveal: vi.fn(),
    ...over,
  };
}

describe('CacheCard, a cache that was read', () => {
  it('says what it is, how big it is, and what is in it', () => {
    renderWithProviders(<CacheCard {...props()} />);
    const region = screen.getByRole('region', { name: /nuget/i });
    expect(within(region).getByRole('heading', { name: 'NuGet' })).toBeInTheDocument();
    expect(within(region).getByText('.NET packages')).toBeInTheDocument();
    expect(within(region).getByText('4.00 GB')).toBeInTheDocument();
    expect(within(region).getByText(/1,902 packages/)).toBeInTheDocument();
    expect(within(region).getByText(/120,000 files/)).toBeInTheDocument();
  });

  it('says how much could be freed, in words', () => {
    renderWithProviders(<CacheCard {...props()} />);
    expect(screen.getByText(/can free 1\.50 GB/i)).toBeInTheDocument();
  });

  it('says it is tidy, with a mark as well as the colour, when there is nothing old', () => {
    renderWithProviders(
      <CacheCard
        {...props({
          card: card({
            reclaimableBytes: 0,
            actions: { review: true, cleanOld: false, clearAll: true, tool: null },
          }),
        })}
      />,
    );
    expect(screen.getByText(/tidy/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clean old versions/i })).not.toBeInTheDocument();
  });

  it('shows the folder it lives in, and can copy it and show it', async () => {
    const p = props();
    const { user } = renderWithProviders(<CacheCard {...p} />);
    expect(screen.getByText('C:\\Users\\me\\.nuget\\packages')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show nuget in its folder/i }));
    expect(p.onReveal).toHaveBeenCalledTimes(1);
  });

  it('lets a long folder path shrink, so the buttons beside it are never pushed out of the card', () => {
    renderWithProviders(<CacheCard {...props()} />);
    const path = screen.getByText('C:\\Users\\me\\.nuget\\packages');
    expect(path).toHaveClass('truncate', 'min-w-0', 'flex-1');
    // Not inside a wrapper that sizes itself to the text, which is what pushed the buttons out.
    expect(path.parentElement).not.toHaveClass('inline-flex');
  });

  it('draws its size against the biggest cache, in a bar that is for the eye only', () => {
    renderWithProviders(<CacheCard {...props()} />);
    const bar = screen.getByTestId('size-bar');
    expect(bar).toHaveStyle({ width: '50%' });
    expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('keeps a small cache visible in that bar', () => {
    renderWithProviders(<CacheCard {...props({ card: card({ bytes: 1 }), biggest: 100 * GB })} />);
    expect(screen.getByTestId('size-bar')).toHaveStyle({ width: '2%' });
  });
});

describe('CacheCard, what can be done', () => {
  it('offers to review, clean old versions and clear all, and says which cache each is for', async () => {
    const p = props();
    const { user } = renderWithProviders(<CacheCard {...p} />);
    await user.click(screen.getByRole('button', { name: /review nuget/i }));
    await user.click(screen.getByRole('button', { name: /clean old versions in nuget/i }));
    await user.click(screen.getByRole('button', { name: /clear all of nuget/i }));
    expect(p.onReview).toHaveBeenCalledTimes(1);
    expect(p.onCleanOld).toHaveBeenCalledTimes(1);
    expect(p.onClearAll).toHaveBeenCalledTimes(1);
  });

  it('offers only what is possible', () => {
    renderWithProviders(
      <CacheCard
        {...props({
          card: card({ actions: { review: false, cleanOld: false, clearAll: false, tool: null } }),
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
  });

  it('cannot be acted on while something else is running', () => {
    renderWithProviders(<CacheCard {...props({ busy: true })} />);
    expect(screen.getByRole('button', { name: /clean old versions in nuget/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /clear all of nuget/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /review nuget/i })).toBeDisabled();
  });

  it('can be read again', async () => {
    const p = props();
    const { user } = renderWithProviders(<CacheCard {...p} />);
    await user.click(screen.getByRole('button', { name: /scan nuget again/i }));
    expect(p.onScan).toHaveBeenCalledTimes(1);
  });
});

describe('CacheCard, a cache only its tool cleans', () => {
  const npm = card({
    id: 'npm',
    label: 'npm',
    tagline: 'JavaScript packages',
    kind: 'opaque',
    bytes: 900 * MB,
    packageCount: 0,
    reclaimableBytes: 0,
    actions: {
      review: false,
      cleanOld: false,
      clearAll: false,
      tool: { kind: 'clear-command', label: 'npm cache clean --force' },
    },
  });

  it("says its own tool cleans it, and offers that tool's command", async () => {
    const p = props({ card: npm });
    const { user } = renderWithProviders(<CacheCard {...p} />);
    expect(screen.getByText(/cleaned by npm/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /clear cache \(npm\)/i }));
    expect(p.onTool).toHaveBeenCalledWith('clear-command');
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument();
  });

  it('calls a prune what it is', async () => {
    const p = props({
      card: card({
        ...npm,
        id: 'pnpm',
        label: 'pnpm',
        actions: { ...npm.actions, tool: { kind: 'tidy', label: 'pnpm store prune' } },
      }),
    });
    const { user } = renderWithProviders(<CacheCard {...p} />);
    await user.click(screen.getByRole('button', { name: /remove unused \(pnpm\)/i }));
    expect(p.onTool).toHaveBeenCalledWith('tidy');
  });

  it('says so when the tool is not installed, and offers nothing', () => {
    renderWithProviders(
      <CacheCard
        {...props({
          card: card({
            ...npm,
            note: 'Only its own tool cleans this cache, and that tool is not installed.',
            actions: { ...npm.actions, tool: null },
          }),
        })}
      />,
    );
    expect(screen.getByText(/that tool is not installed/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /clear cache|remove unused/i }),
    ).not.toBeInTheDocument();
  });
});

describe('CacheCard, other states', () => {
  it('shows a cache waiting its turn without any actions', () => {
    renderWithProviders(
      <CacheCard
        {...props({
          card: card({
            state: 'queued',
            bytes: 0,
            files: 0,
            root: null,
            actions: { review: false, cleanOld: false, clearAll: false, tool: null },
          }),
        })}
      />,
    );
    expect(screen.getByText(/waiting/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows how much has been found so far while it is being read', () => {
    renderWithProviders(
      <CacheCard
        {...props({
          card: card({
            state: 'scanning',
            bytes: 12.4 * GB,
            files: 83_000,
            root: null,
            reclaimableBytes: 0,
            packageCount: 0,
            actions: { review: false, cleanOld: false, clearAll: false, tool: null },
          }),
        })}
      />,
    );
    expect(screen.getByText('12.4 GB')).toBeInTheDocument();
    expect(screen.getByText(/83,000 files so far/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
  });

  it('says when a remembered cache was read, and that it will be read again first', async () => {
    const p = props({
      card: card({ state: 'remembered', needsScan: true, scannedAt: 1_000_000 - 3 * 86_400_000 }),
    });
    renderWithProviders(<CacheCard {...p} />);
    expect(screen.getByText(/scanned 3d ago/i)).toBeInTheDocument();
  });

  it('explains a cache it could not read or recognise, and only offers to read it again', async () => {
    const p = props({
      card: card({
        state: 'unverified',
        note: 'This folder is not laid out like a NuGet cache, so nothing in it is offered for clean-up.',
        reclaimableBytes: 0,
        actions: { review: false, cleanOld: false, clearAll: false, tool: null },
      }),
    });
    const { user } = renderWithProviders(<CacheCard {...p} />);
    expect(screen.getByText(/not laid out like a nuget cache/i)).toBeInTheDocument();
    expect(screen.getByText(/not recognised/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /scan nuget again/i }));
    expect(p.onScan).toHaveBeenCalled();
  });

  it('shows a cache that could not be read as an error, in words', () => {
    renderWithProviders(
      <CacheCard
        {...props({
          card: card({
            state: 'error',
            note: 'It could not be read.',
            actions: { review: false, cleanOld: false, clearAll: false, tool: null },
          }),
        })}
      />,
    );
    expect(screen.getByText(/could not read/i)).toBeInTheDocument();
    expect(screen.getByText('It could not be read.')).toBeInTheDocument();
  });

  it('says an empty cache is empty', () => {
    renderWithProviders(
      <CacheCard
        {...props({
          card: card({
            bytes: 0,
            files: 0,
            packageCount: 0,
            reclaimableBytes: 0,
            actions: { review: false, cleanOld: false, clearAll: false, tool: null },
          }),
        })}
      />,
    );
    expect(screen.getByText(/empty/i)).toBeInTheDocument();
  });
});
