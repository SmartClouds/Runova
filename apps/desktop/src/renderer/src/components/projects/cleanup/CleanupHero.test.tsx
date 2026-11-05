import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CompositionPart } from '@/lib/projectCleanup/selection';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CleanupHero, type CleanupHeroProps } from './CleanupHero';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const PARTS: CompositionPart[] = [
  { id: 'own', label: 'Your files', bytes: 600 * MB },
  { id: 'git', label: 'Git history', bytes: 100 * MB },
  { id: 'dependencies', label: 'Dependencies', bytes: 2 * GB },
  { id: 'build', label: 'Build output', bytes: 400 * MB },
];

function hero(over: Partial<CleanupHeroProps> = {}): CleanupHeroProps {
  return {
    phase: 'ready',
    freeBytes: 2.4 * GB,
    totalBytes: 3.1 * GB,
    parts: PARTS,
    scannedAt: Date.now() - 5 * 60_000,
    filesSeen: 0,
    lookingIn: null,
    onScan: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

describe('CleanupHero when the scan is done', () => {
  it('says how much can be freed and how much the project uses in all', () => {
    renderWithProviders(<CleanupHero {...hero()} />);
    expect(screen.getByText('2.40 GB')).toBeInTheDocument();
    expect(screen.getByText(/can be freed/i)).toBeInTheDocument();
    expect(screen.getByText(/uses 3\.10 GB in all/i)).toBeInTheDocument();
  });

  it('draws the space as a bar that says in words what it shows', () => {
    renderWithProviders(<CleanupHero {...hero()} />);
    const bar = screen.getByRole('img', { name: /where the space goes/i });
    expect(bar).toHaveAccessibleName(/Your files 600 MB/);
    expect(bar).toHaveAccessibleName(/Dependencies 2\.00 GB/);
  });

  it('lists each part with its size, so colour is never the only way to read the bar', () => {
    renderWithProviders(<CleanupHero {...hero()} />);
    const legend = screen.getByRole('list', { name: /space by kind/i });
    const items = within(legend).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Your files600 MB',
      'Git history100 MB',
      'Dependencies2.00 GB',
      'Build output400 MB',
    ]);
  });

  it('says when it was scanned and offers to scan again', async () => {
    const props = hero();
    const { user } = renderWithProviders(<CleanupHero {...props} />);
    expect(screen.getByText(/scanned 5m ago/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /scan again/i }));
    expect(props.onScan).toHaveBeenCalledTimes(1);
  });

  it('says "just now" for a scan that has only just finished', () => {
    renderWithProviders(<CleanupHero {...hero({ scannedAt: Date.now() - 2000 })} />);
    expect(screen.getByText(/scanned just now/i)).toBeInTheDocument();
  });

  it('is calm about a project with nothing to free', () => {
    renderWithProviders(
      <CleanupHero {...hero({ freeBytes: 0, totalBytes: 40 * MB, parts: PARTS.slice(0, 1) })} />,
    );
    expect(screen.getByText('Nothing to clean up')).toBeInTheDocument();
    expect(screen.getByText(/uses 40\.0 MB in all/i)).toBeInTheDocument();
    expect(screen.queryByText(/can be freed/i)).not.toBeInTheDocument();
  });

  it('has no cancel button once it is done', () => {
    renderWithProviders(<CleanupHero {...hero()} />);
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });
});

describe('CleanupHero while scanning', () => {
  const scanning = (over: Partial<CleanupHeroProps> = {}) =>
    hero({
      phase: 'scanning',
      freeBytes: 0,
      totalBytes: 0,
      parts: [],
      scannedAt: null,
      filesSeen: 12480,
      lookingIn: 'Project folder',
      ...over,
    });

  it('says it is looking, and how many files it has been through', () => {
    renderWithProviders(<CleanupHero {...scanning()} />);
    expect(screen.getByText(/looking through your project/i)).toBeInTheDocument();
    expect(screen.getByText(/12,480 files/)).toBeInTheDocument();
    expect(screen.getByText(/in project folder/i)).toBeInTheDocument();
  });

  it('shows what it has found so far, as it finds it', () => {
    renderWithProviders(<CleanupHero {...scanning({ freeBytes: 512 * MB })} />);
    expect(screen.getByText('512 MB')).toBeInTheDocument();
    expect(screen.getByText(/found so far/i)).toBeInTheDocument();
  });

  it('lets the person stop it', async () => {
    const props = scanning();
    const { user } = renderWithProviders(<CleanupHero {...props} />);
    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /scan again/i })).not.toBeInTheDocument();
  });

  it('announces progress politely rather than shouting every file', () => {
    renderWithProviders(<CleanupHero {...scanning()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/12,480 files/);
  });

  it('draws no legend and no bar until it knows the sizes', () => {
    renderWithProviders(<CleanupHero {...scanning()} />);
    expect(screen.queryByRole('img', { name: /where the space goes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /space by kind/i })).not.toBeInTheDocument();
  });
});
