import type { ProviderScan, ScanItem } from '@runova/core';
import { act, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ReviewView, type ReviewViewProps } from './ReviewView';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const NOW = 10_000_000_000;
const DAY = 86_400_000;

let counter = 0;
function item(
  group: string,
  version: string | null,
  bytes: number,
  extra: Partial<ScanItem> = {},
): ScanItem {
  counter += 1;
  return {
    id: `i${counter}`,
    group,
    groupLabel: group,
    version,
    bytes,
    sharedBytes: 0,
    files: 3,
    newestMs: NOW - 3 * DAY,
    ...extra,
  };
}

function provider(items: ScanItem[], over: Partial<ProviderScan> = {}): ProviderScan {
  return {
    id: 'bun',
    label: 'Bun',
    tagline: 'JavaScript packages',
    kind: 'versioned',
    status: 'ready',
    root: '/home/me/.bun/install/cache',
    bytes: items.reduce((sum, entry) => sum + entry.bytes, 0),
    files: items.length * 3,
    sharedBytes: 0,
    unreadable: 0,
    items,
    clearCommand: null,
    tidyCommand: null,
    afterClearing: '',
    ...over,
  };
}

const react1 = item('react', '19.2.8', 100 * MB);
const react2 = item('react', '19.3.0', 200 * MB);
const react3 = item('react', '19.3.1', 300 * MB);
const ts1 = item('typescript', '5.4.5', 50 * MB);
const ts2 = item('typescript', '7.0.2', 250 * MB);
const solo = item('solo', '1.0.0', 80 * MB);

const bun = provider([react1, react2, react3, ts1, ts2, solo]);

function view(over: Partial<ReviewViewProps> = {}): ReviewViewProps {
  return {
    provider: bun,
    keep: 1,
    statuses: {},
    busy: false,
    cleaning: null,
    now: NOW,
    onKeepChange: vi.fn(),
    onBack: vi.fn(),
    onReveal: vi.fn(),
    onDelete: vi.fn(),
    onRetry: vi.fn(),
    ...over,
  };
}

const row = (name: RegExp | string) => screen.getByRole('checkbox', { name });

/**
 * Renders the review so its props can be changed afterwards. `rerender` would replace the whole
 * tree, providers included, so the props live in state inside the tree instead.
 */
function renderReview(initial: ReviewViewProps) {
  let change: (patch: Partial<ReviewViewProps>) => void = () => undefined;
  function Harness(): React.JSX.Element {
    const [props, setProps] = useState(initial);
    useEffect(() => {
      change = (patch) => setProps((previous) => ({ ...previous, ...patch }));
    }, []);
    return <ReviewView {...props} />;
  }
  const rendered = renderWithProviders(<Harness />);
  return { ...rendered, update: (patch: Partial<ReviewViewProps>) => act(() => change(patch)) };
}

describe('ReviewView, the header', () => {
  it('names the cache, says what it takes and where it is', () => {
    renderWithProviders(<ReviewView {...view()} />);
    expect(screen.getByRole('heading', { name: 'Bun' })).toBeInTheDocument();
    expect(screen.getByText('980 MB')).toBeInTheDocument();
    expect(screen.getByText('/home/me/.bun/install/cache')).toBeInTheDocument();
  });

  it('goes back to all the caches', async () => {
    const p = view();
    const { user } = renderWithProviders(<ReviewView {...p} />);
    await user.click(screen.getByRole('button', { name: /all caches/i }));
    expect(p.onBack).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewView, the list', () => {
  it('lists packages with the most to free first, each saying what it holds', () => {
    renderWithProviders(<ReviewView {...view()} />);
    const list = screen.getByRole('list', { name: /packages/i });
    const names = within(list)
      .getAllByRole('checkbox', { name: /select all versions of/i })
      .map((box) => box.getAttribute('aria-label'));
    expect(names).toEqual([
      'Select all versions of react',
      'Select all versions of typescript',
      'Select all versions of solo',
    ]);
    expect(screen.getByText(/3 versions/)).toBeInTheDocument();
    expect(screen.getByText(/can free 300 MB/i)).toBeInTheDocument();
    expect(screen.getByText(/latest only/i)).toBeInTheDocument();
  });

  it('shows the versions of a package when it is opened, newest first, with the newest marked', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    expect(screen.queryByText('19.3.1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show versions of react/i }));
    const versions = screen.getAllByText(/^19\.\d\.\d+$/).map((el) => el.textContent);
    expect(versions).toEqual(['19.3.1', '19.3.0', '19.2.8']);
    expect(screen.getByText(/newest, kept/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide versions of react/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('says how big each version is and how long ago it changed', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    await user.click(screen.getByRole('button', { name: /show versions of react/i }));
    const versions = within(screen.getByRole('list', { name: /versions of react/i }));
    expect(versions.getByText('300 MB')).toBeInTheDocument();
    expect(versions.getAllByText(/changed 3d ago/i)).toHaveLength(3);
  });

  it('copes with a package that has something with no version', async () => {
    const odd = provider([item('other', null, 20 * MB, { groupLabel: 'Other files' })]);
    const { user } = renderWithProviders(<ReviewView {...view({ provider: odd })} />);
    await user.click(screen.getByRole('button', { name: /show versions of other files/i }));
    expect(screen.getByText(/no version/i)).toBeInTheDocument();
  });

  it('warns about a package whose versions it could not put in order', async () => {
    const odd = provider([item('tool', '1.0.0', MB), item('tool', 'LATEST', MB)]);
    const { user } = renderWithProviders(<ReviewView {...view({ provider: odd })} />);
    await user.click(screen.getByRole('button', { name: /show versions of tool/i }));
    expect(screen.getByText(/could not tell which is newest/i)).toBeInTheDocument();
  });

  it('says there is nothing to review in an empty cache', () => {
    renderWithProviders(<ReviewView {...view({ provider: provider([]) })} />);
    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
  });
});

describe('ReviewView, picking', () => {
  it('starts with every old version picked and the newest left alone', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    await user.click(screen.getByRole('button', { name: /show versions of react/i }));
    expect(row(/select react 19\.2\.8/i)).toBeChecked();
    expect(row(/select react 19\.3\.0/i)).toBeChecked();
    expect(row(/select react 19\.3\.1/i)).not.toBeChecked();
  });

  it('says what is picked and what it frees, on the button that deletes it', () => {
    renderWithProviders(<ReviewView {...view()} />);
    const bar = screen.getByRole('region', { name: /selected versions/i });
    expect(within(bar).getByText(/3 items selected/i)).toBeInTheDocument();
    expect(within(bar).getByText(/frees up to 350 MB/i)).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /delete 350 mb/i })).toBeInTheDocument();
  });

  it('shows a package as partly picked, and picks all of it with one click', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    const box = row(/select all versions of react/i);
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    await user.click(box);
    expect(box).toBeChecked();
    expect(
      within(screen.getByRole('region', { name: /selected versions/i })).getByText(
        /4 items selected/i,
      ),
    ).toBeInTheDocument();
    await user.click(box);
    expect(box).not.toBeChecked();
  });

  it('can pick or drop a single version', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    await user.click(screen.getByRole('button', { name: /show versions of react/i }));
    await user.click(row(/select react 19\.3\.1/i));
    const bar = screen.getByRole('region', { name: /selected versions/i });
    expect(within(bar).getByText(/4 items selected/i)).toBeInTheDocument();
    expect(within(bar).getByText(/frees up to 650 MB/i)).toBeInTheDocument();
  });

  it('can pick all, nothing, or just the old versions', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    await user.click(screen.getByRole('button', { name: /select all/i }));
    expect(screen.getByText(/6 items selected/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /select none/i }));
    expect(screen.queryByRole('region', { name: /selected versions/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /old versions/i }));
    expect(screen.getByText(/3 items selected/i)).toBeInTheDocument();
  });

  it('starts over with the new default when the number to keep changes', () => {
    const { update } = renderReview(view({ keep: 1 }));
    expect(screen.getByText(/3 items selected/i)).toBeInTheDocument();
    update({ keep: 2 });
    expect(screen.getByText(/1 item selected/i)).toBeInTheDocument();
  });

  it('lets the person say how many to keep', async () => {
    const p = view();
    const { user } = renderWithProviders(<ReviewView {...p} />);
    await user.click(
      within(screen.getByRole('group', { name: /versions to keep/i })).getByRole('button', {
        name: '2',
      }),
    );
    expect(p.onKeepChange).toHaveBeenCalledWith(2);
  });

  it('hands the picked versions over to be deleted', async () => {
    const p = view();
    const { user } = renderWithProviders(<ReviewView {...p} />);
    await user.click(screen.getByRole('button', { name: /delete 350 mb/i }));
    expect(p.onDelete).toHaveBeenCalledTimes(1);
    const picked = (p.onDelete as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReadonlySet<string>;
    expect([...picked].sort()).toEqual([react1.id, react2.id, ts1.id].sort());
  });

  it('drops a pick that is no longer in the cache', () => {
    const { update } = renderReview(view());
    expect(screen.getByText(/3 items selected/i)).toBeInTheDocument();
    update({ provider: provider([react2, react3, ts1, ts2, solo]) });
    expect(screen.getByText(/2 items selected/i)).toBeInTheDocument();
  });
});

describe('ReviewView, search and showing more', () => {
  it('filters the packages by name', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    await user.type(screen.getByRole('searchbox', { name: /search packages/i }), 'TYPE');
    expect(
      screen.getByRole('checkbox', { name: /select all versions of typescript/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /select all versions of react/i }),
    ).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    const { user } = renderWithProviders(<ReviewView {...view()} />);
    await user.type(screen.getByRole('searchbox', { name: /search packages/i }), 'zzz');
    expect(screen.getByText(/nothing matches/i)).toBeInTheDocument();
  });

  it('shows the first 50 packages and the rest on request', async () => {
    const many = provider(
      Array.from({ length: 120 }, (_, index) =>
        item(`pkg-${String(index).padStart(3, '0')}`, '1.0.0', MB),
      ),
    );
    const { user } = renderWithProviders(<ReviewView {...view({ provider: many })} />);
    const count = () => screen.getAllByRole('checkbox', { name: /select all versions of/i }).length;
    expect(count()).toBe(50);
    await user.click(screen.getByRole('button', { name: /show 50 more/i }));
    expect(count()).toBe(100);
    await user.click(screen.getByRole('button', { name: /show 20 more/i }));
    expect(count()).toBe(120);
    expect(screen.queryByRole('button', { name: /show .* more/i })).not.toBeInTheDocument();
  });
});

describe('ReviewView, while and after deleting', () => {
  it('cannot be changed while something is running', async () => {
    const { user } = renderWithProviders(<ReviewView {...view({ busy: true })} />);
    await user.click(screen.getByRole('button', { name: /show versions of react/i }));
    expect(row(/select react 19\.2\.8/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete 350 mb|deleting/i })).toBeDisabled();
  });

  it('turns the bar into progress while deleting', () => {
    renderWithProviders(
      <ReviewView {...view({ busy: true, cleaning: { processed: 1, total: 3 } })} />,
    );
    const bar = screen.getByRole('region', { name: /selected versions/i });
    expect(within(bar).getByRole('status')).toHaveTextContent(/1 of 3 deleted/i);
    expect(within(bar).getByRole('progressbar', { name: /deleting/i })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
  });

  it('shows what was freed for a version that went', async () => {
    const { user } = renderWithProviders(
      <ReviewView
        {...view({ statuses: { [`bun/${react1.id}`]: { status: 'done', bytes: 100 * MB } } })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /show versions of react/i }));
    expect(screen.getByText(/freed 100 mb/i)).toBeInTheDocument();
  });

  it('shows why a version could not go, and lets the person try again', async () => {
    const p = view({
      statuses: {
        [`bun/${react1.id}`]: { status: 'failed', reason: 'It is in use by another program.' },
      },
    });
    const { user } = renderWithProviders(<ReviewView {...p} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/in use by another program/i);
    await user.click(screen.getByRole('button', { name: /try again: react 19\.2\.8/i }));
    expect(p.onRetry).toHaveBeenCalledWith(react1.id);
  });

  it('opens a package that has a problem, so the reason is not hidden', () => {
    renderWithProviders(
      <ReviewView
        {...view({
          statuses: { [`bun/${react1.id}`]: { status: 'failed', reason: 'In use.' } },
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/in use/i);
  });

  it('writes a size in gigabytes with its decimals', () => {
    const huge = provider([item('big', '1.0.0', 3 * GB), item('big', '2.0.0', GB)]);
    renderWithProviders(<ReviewView {...view({ provider: huge })} />);
    // Once in the header, once on the package.
    expect(screen.getAllByText('4.00 GB')).toHaveLength(2);
  });
});
