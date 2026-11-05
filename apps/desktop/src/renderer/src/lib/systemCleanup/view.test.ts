import {
  type CacheProviderId,
  IDLE_SCAN,
  type ProviderScan,
  type ScanItem,
  type ScanProgress,
  type SystemCleanupScan,
} from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  type CardModel,
  cardModels,
  defaultSelection,
  filterCards,
  filterGroups,
  groupState,
  overview,
  type ProviderSummary,
  presetSelection,
  reviewGroups,
  selectionTotals,
  sortCards,
  summaryOf,
  toggleGroup,
  toggleItem,
} from './view';

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
    files: 4,
    newestMs: 1_000,
    ...extra,
  };
}

function provider(id: CacheProviderId, overrides: Partial<ProviderScan> = {}): ProviderScan {
  return {
    id,
    label: id.toUpperCase(),
    tagline: `${id} things`,
    kind: 'versioned',
    status: 'ready',
    root: `/caches/${id}`,
    bytes: 0,
    files: 0,
    sharedBytes: 0,
    unreadable: 0,
    items: [],
    clearCommand: null,
    tidyCommand: null,
    afterClearing: '',
    ...overrides,
  };
}

function scanOf(
  providers: ProviderScan[],
  extra: Partial<SystemCleanupScan> = {},
): SystemCleanupScan {
  return {
    scanId: 's1',
    startedAt: 1,
    finishedAt: 2,
    cancelled: false,
    providers,
    volumes: [],
    ...extra,
  };
}

const nuget = provider('nuget', {
  bytes: 700,
  files: 20,
  items: [item('a', '1.0.0', 100), item('a', '2.0.0', 200), item('b', '1.0.0', 400)],
});

describe('summaryOf', () => {
  it('keeps the figures worth remembering about a cache', () => {
    expect(summaryOf(nuget, 5_000, 1)).toEqual({
      id: 'nuget',
      label: 'NUGET',
      tagline: 'nuget things',
      kind: 'versioned',
      bytes: 700,
      files: 20,
      packageCount: 2,
      reclaimableBytes: 100,
      root: '/caches/nuget',
      scannedAt: 5_000,
      clearLabel: null,
      tidyLabel: null,
    });
  });

  it('remembers the tool command a cache has', () => {
    const npm = provider('npm', {
      kind: 'opaque',
      bytes: 50,
      clearCommand: { label: 'npm cache clean --force' },
    });
    expect(summaryOf(npm, 1, 1)?.clearLabel).toBe('npm cache clean --force');
  });

  it('remembers nothing about a cache that was not read properly', () => {
    for (const status of ['missing', 'unverified', 'error', 'cancelled', 'queued'] as const) {
      expect(summaryOf(provider('nuget', { status, bytes: 5 }), 1, 1), status).toBeNull();
    }
  });
});

function summary(id: CacheProviderId, overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id,
    label: id.toUpperCase(),
    tagline: `${id} things`,
    kind: 'versioned',
    bytes: 300,
    files: 9,
    packageCount: 3,
    reclaimableBytes: 120,
    root: `/caches/${id}`,
    scannedAt: 100,
    clearLabel: null,
    tidyLabel: null,
    ...overrides,
  };
}

describe('cardModels', () => {
  it('shows nothing before anything has been scanned or remembered', () => {
    expect(cardModels({ scan: null, progress: IDLE_SCAN, summaries: {}, keep: 1 })).toEqual({
      cards: [],
      absent: [],
    });
  });

  it('shows a cache read this session as fresh, with what could be freed', () => {
    const { cards } = cardModels({
      scan: scanOf([nuget]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'nuget',
      state: 'live',
      bytes: 700,
      files: 20,
      packageCount: 2,
      reclaimableBytes: 100,
      root: '/caches/nuget',
      needsScan: false,
      actions: { review: true, cleanOld: true, clearAll: true, tool: null },
    });
  });

  it('shows a remembered cache as remembered, asking for a scan before anything is done to it', () => {
    const { cards } = cardModels({
      scan: null,
      progress: IDLE_SCAN,
      summaries: { nuget: summary('nuget') },
      keep: 1,
    });
    expect(cards[0]).toMatchObject({
      state: 'remembered',
      bytes: 300,
      reclaimableBytes: 120,
      scannedAt: 100,
      needsScan: true,
      actions: { review: true, cleanOld: true, clearAll: true },
    });
  });

  it('prefers what was just read over what was remembered', () => {
    const { cards } = cardModels({
      scan: scanOf([nuget]),
      progress: IDLE_SCAN,
      summaries: { nuget: summary('nuget', { bytes: 999_999 }) },
      keep: 1,
    });
    expect(cards[0]?.bytes).toBe(700);
    expect(cards[0]?.state).toBe('live');
  });

  it('falls back to what was remembered when reading a cache was cut short', () => {
    const { cards } = cardModels({
      scan: scanOf([provider('nuget', { status: 'cancelled' })]),
      progress: IDLE_SCAN,
      summaries: { nuget: summary('nuget') },
      keep: 1,
    });
    expect(cards[0]).toMatchObject({ state: 'remembered', bytes: 300 });
  });

  it('shows a cache waiting its turn and one being read, with the count so far', () => {
    const progress: ScanProgress = {
      ...IDLE_SCAN,
      running: true,
      requestId: 'r',
      order: ['nuget', 'bun'],
      providers: {
        nuget: { status: 'scanning', label: 'NuGet', bytes: 1234, files: 56, result: null },
        bun: { status: 'queued', label: 'Bun', bytes: 0, files: 0, result: null },
      },
    };
    const { cards } = cardModels({ scan: null, progress, summaries: {}, keep: 1 });
    expect(cards.map((card) => [card.id, card.state])).toEqual([
      ['nuget', 'scanning'],
      ['bun', 'queued'],
    ]);
    expect(cards[0]).toMatchObject({ bytes: 1234, files: 56 });
  });

  it('keeps a finished cache in the grid while the others are still being read', () => {
    const progress: ScanProgress = {
      ...IDLE_SCAN,
      running: true,
      requestId: 'r',
      order: ['nuget', 'bun'],
      providers: {
        nuget: { status: 'ready', label: 'NuGet', bytes: 700, files: 20, result: nuget },
        bun: { status: 'scanning', label: 'Bun', bytes: 10, files: 1, result: null },
      },
    };
    const { cards } = cardModels({ scan: null, progress, summaries: {}, keep: 1 });
    expect(cards.find((card) => card.id === 'nuget')).toMatchObject({ state: 'live', bytes: 700 });
    expect(cards.find((card) => card.id === 'bun')?.state).toBe('scanning');
  });

  it('puts caches that are not on this machine aside, by name', () => {
    const { cards, absent } = cardModels({
      scan: scanOf([nuget, provider('cargo', { status: 'missing', label: 'Cargo' })]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(cards.map((card) => card.id)).toEqual(['nuget']);
    expect(absent).toEqual(['Cargo']);
  });

  it('explains a cache it could not read, and offers nothing to clean in it', () => {
    const { cards } = cardModels({
      scan: scanOf([
        provider('nuget', { status: 'unverified', bytes: 500, error: 'Not laid out like NuGet.' }),
        provider('bun', { status: 'error', error: 'It could not be read.' }),
      ]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(cards[0]).toMatchObject({
      state: 'unverified',
      note: 'Not laid out like NuGet.',
      actions: { review: false, cleanOld: false, clearAll: false, tool: null },
    });
    expect(cards[1]).toMatchObject({ state: 'error', note: 'It could not be read.' });
  });

  it('offers only the tool command for a cache only its tool cleans', () => {
    const npm = provider('npm', {
      kind: 'opaque',
      bytes: 900,
      clearCommand: { label: 'npm cache clean --force' },
    });
    const pnpm = provider('pnpm', {
      kind: 'opaque',
      bytes: 400,
      tidyCommand: { label: 'pnpm store prune' },
    });
    const { cards } = cardModels({
      scan: scanOf([npm, pnpm]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(cards[0]?.actions).toEqual({
      review: false,
      cleanOld: false,
      clearAll: false,
      tool: { kind: 'clear-command', label: 'npm cache clean --force' },
    });
    expect(cards[1]?.actions.tool).toEqual({ kind: 'tidy', label: 'pnpm store prune' });
    expect(cards[1]?.reclaimableBytes).toBe(0);
  });

  it('says so when the tool that cleans a cache is not installed', () => {
    const npm = provider('npm', { kind: 'opaque', bytes: 900 });
    const { cards } = cardModels({
      scan: scanOf([npm]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(cards[0]?.actions.tool).toBeNull();
    expect(cards[0]?.note).toMatch(/not installed|its own tool/i);
  });

  it('has nothing to clean in a cache that is already tidy', () => {
    const tidy = provider('nuget', { bytes: 100, items: [item('a', '1.0.0', 100)] });
    const { cards } = cardModels({
      scan: scanOf([tidy]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(cards[0]).toMatchObject({
      reclaimableBytes: 0,
      actions: { review: true, cleanOld: false, clearAll: true },
    });
  });

  it('offers no clean-up of an empty cache', () => {
    const empty = provider('nuget', { bytes: 0, items: [] });
    const { cards } = cardModels({
      scan: scanOf([empty]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(cards[0]?.actions).toMatchObject({ review: false, cleanOld: false, clearAll: false });
  });

  it('works out what could be freed for the number of versions to keep', () => {
    const many = provider('nuget', {
      bytes: 600,
      items: [item('a', '1.0.0', 100), item('a', '2.0.0', 200), item('a', '3.0.0', 300)],
    });
    const at = (keep: number) =>
      cardModels({ scan: scanOf([many]), progress: IDLE_SCAN, summaries: {}, keep }).cards[0]
        ?.reclaimableBytes;
    expect(at(1)).toBe(300);
    expect(at(2)).toBe(100);
    expect(at(3)).toBe(0);
  });
});

function card(overrides: Partial<CardModel> & Pick<CardModel, 'id'>): CardModel {
  return {
    label: overrides.id,
    tagline: '',
    kind: 'versioned',
    state: 'live',
    bytes: 0,
    files: 0,
    packageCount: 0,
    reclaimableBytes: 0,
    root: null,
    scannedAt: null,
    needsScan: false,
    note: null,
    actions: { review: true, cleanOld: false, clearAll: true, tool: null },
    ...overrides,
  };
}

describe('sortCards and filterCards', () => {
  const cards = [
    card({ id: 'bun', label: 'Bun', bytes: 10, reclaimableBytes: 0 }),
    card({
      id: 'nuget',
      label: 'NuGet',
      bytes: 900,
      reclaimableBytes: 300,
      tagline: '.NET packages',
    }),
    card({ id: 'npm', label: 'npm', kind: 'opaque', bytes: 500, tagline: 'JavaScript packages' }),
  ];

  it('puts the largest first by default', () => {
    expect(sortCards(cards, 'size').map((c) => c.id)).toEqual(['nuget', 'npm', 'bun']);
  });

  it('can put what could be freed first, or go by name', () => {
    expect(sortCards(cards, 'reclaimable').map((c) => c.id)[0]).toBe('nuget');
    expect(sortCards(cards, 'name').map((c) => c.id)).toEqual(['bun', 'npm', 'nuget']);
  });

  it('does not change the list it is given', () => {
    const before = cards.map((c) => c.id);
    sortCards(cards, 'name');
    expect(cards.map((c) => c.id)).toEqual(before);
  });

  it('filters to the caches with something to free, or to those a tool cleans', () => {
    expect(filterCards(cards, { tab: 'free', query: '' }).map((c) => c.id)).toEqual(['nuget']);
    expect(filterCards(cards, { tab: 'tool', query: '' }).map((c) => c.id)).toEqual(['npm']);
    expect(filterCards(cards, { tab: 'all', query: '' })).toHaveLength(3);
  });

  it('searches names and descriptions without regard to case', () => {
    expect(filterCards(cards, { tab: 'all', query: 'NUGET' }).map((c) => c.id)).toEqual(['nuget']);
    expect(filterCards(cards, { tab: 'all', query: 'javascript' }).map((c) => c.id)).toEqual([
      'npm',
    ]);
    expect(filterCards(cards, { tab: 'all', query: '  ' })).toHaveLength(3);
    expect(filterCards(cards, { tab: 'all', query: 'zzz' })).toEqual([]);
  });
});

describe('overview', () => {
  it('adds up the caches, and says what could be freed and how many packages there are', () => {
    const { cards } = cardModels({
      scan: scanOf([
        nuget,
        provider('bun', { bytes: 100, files: 5, items: [item('x', '1.0.0', 100)] }),
      ]),
      progress: IDLE_SCAN,
      summaries: {},
      keep: 1,
    });
    expect(overview(cards, [])).toMatchObject({
      totalBytes: 800,
      totalFiles: 25,
      packageCount: 3,
      reclaimableBytes: 100,
      cachesFound: 2,
      remembered: false,
    });
  });

  it('says when the figures are from an earlier scan, and how old the oldest is', () => {
    const { cards } = cardModels({
      scan: null,
      progress: IDLE_SCAN,
      summaries: {
        nuget: summary('nuget', { scannedAt: 50 }),
        bun: summary('bun', { scannedAt: 90 }),
      },
      keep: 1,
    });
    expect(overview(cards, [])).toMatchObject({ remembered: true, scannedAt: 50, totalBytes: 600 });
  });

  it('breaks the total into parts largest first, folding the small ones into one', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      card({ id: `c${index}` as CacheProviderId, label: `C${index}`, bytes: (index + 1) * 100 }),
    );
    const { parts } = overview(many, []);
    expect(parts).toHaveLength(7);
    expect(parts[0]).toMatchObject({ label: 'C8', bytes: 900 });
    expect(parts.at(-1)).toMatchObject({ id: 'others', label: 'Everything else' });
    expect(parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(4500);
  });

  it('shows every part when there are few', () => {
    const few = [card({ id: 'bun', bytes: 10 }), card({ id: 'npm', bytes: 20 })];
    expect(overview(few, []).parts.map((part) => part.id)).toEqual(['npm', 'bun']);
  });

  it('picks the disk the caches take most of, and leaves out one they barely touch', () => {
    const volumes = [
      { mount: 'D:', totalBytes: 1000, freeBytes: 900, cacheBytes: 10 },
      { mount: 'C:', totalBytes: 500, freeBytes: 31, cacheBytes: 300 },
    ];
    expect(overview([], volumes).volume).toEqual(volumes[1]);
    expect(overview([], []).volume).toBeNull();
  });
});

describe('the review of one cache', () => {
  const bun = provider('bun', {
    bytes: 1000,
    items: [
      item('react', '19.2.8', 100, { newestMs: 10 }),
      item('react', '19.3.1', 300, { newestMs: 30 }),
      item('react', '19.3.0', 200, { newestMs: 20 }),
      item('typescript', '5.4.5', 50),
      item('typescript', '7.0.2', 250),
      item('solo', '1.0.0', 80),
      item('other', null, 20, { groupLabel: 'Other files' }),
    ],
  });

  it('groups versions, newest first, with the newest marked as kept', () => {
    const groups = reviewGroups(bun, 1);
    const react = groups.find((group) => group.key === 'react');
    expect(react?.versions.map((v) => [v.version, v.kept])).toEqual([
      ['19.3.1', true],
      ['19.3.0', false],
      ['19.2.8', false],
    ]);
    expect(react).toMatchObject({ bytes: 600, reclaimableBytes: 300, hasOld: true });
  });

  it('keeps more when asked to', () => {
    const react = reviewGroups(bun, 2).find((group) => group.key === 'react');
    expect(react?.versions.filter((v) => v.kept).map((v) => v.version)).toEqual([
      '19.3.1',
      '19.3.0',
    ]);
  });

  it('puts the groups with the most to free first, and things with no version last', () => {
    const keys = reviewGroups(bun, 1).map((group) => group.key);
    expect(keys.slice(0, 2)).toEqual(['react', 'typescript']);
    expect(keys.at(-1)).toBe('other');
  });

  it('has nothing to free in a package with one version', () => {
    const solo = reviewGroups(bun, 1).find((group) => group.key === 'solo');
    expect(solo).toMatchObject({ hasOld: false, reclaimableBytes: 0 });
    expect(solo?.versions[0]?.kept).toBe(true);
  });

  it('flags a package whose versions could not be put in order', () => {
    const odd = provider('nuget', {
      items: [item('tool', '1.0.0', 5), item('tool', 'LATEST', 5), item('tool', '2.0.0', 5)],
    });
    expect(reviewGroups(odd, 1)[0]).toMatchObject({ unordered: true, hasOld: false });
  });

  it('filters packages by name', () => {
    const groups = reviewGroups(bun, 1);
    expect(filterGroups(groups, 'TYPE').map((group) => group.key)).toEqual(['typescript']);
    expect(filterGroups(groups, '')).toHaveLength(groups.length);
  });
});

describe('picking what to delete', () => {
  const bun = provider('bun', {
    items: [
      item('react', '19.2.8', 100),
      item('react', '19.3.1', 300),
      item('typescript', '5.4.5', 50),
      item('typescript', '7.0.2', 250),
      item('other', null, 20),
    ],
  });
  const groups = reviewGroups(bun, 1);
  const idOf = (group: string, version: string | null): string =>
    bun.items.find((entry) => entry.group === group && entry.version === version)?.id ?? '';

  it('starts with every old version picked and every newest one left', () => {
    const picked = defaultSelection(bun, 1);
    expect([...picked].sort()).toEqual(
      [idOf('react', '19.2.8'), idOf('typescript', '5.4.5')].sort(),
    );
  });

  it('can pick everything, nothing, or just the old versions', () => {
    expect(presetSelection(bun, 1, 'all').size).toBe(5);
    expect(presetSelection(bun, 1, 'none').size).toBe(0);
    expect(presetSelection(bun, 1, 'old')).toEqual(defaultSelection(bun, 1));
  });

  it('reads a group as none, some or all picked', () => {
    const react = groups.find((group) => group.key === 'react');
    if (!react) throw new Error('missing group');
    expect(groupState(react, new Set())).toBe('none');
    expect(groupState(react, new Set([idOf('react', '19.2.8')]))).toBe('some');
    expect(groupState(react, new Set([idOf('react', '19.2.8'), idOf('react', '19.3.1')]))).toBe(
      'all',
    );
  });

  it('picks a whole group, or clears it if all of it was picked', () => {
    const react = groups.find((group) => group.key === 'react');
    if (!react) throw new Error('missing group');
    const picked = toggleGroup(react, new Set());
    expect(picked.size).toBe(2);
    expect(toggleGroup(react, picked).size).toBe(0);
    const partly = toggleGroup(react, new Set([idOf('react', '19.2.8')]));
    expect(partly.size).toBe(2);
  });

  it('toggles one version without touching the others', () => {
    const start = new Set([idOf('react', '19.2.8')]);
    const added = toggleItem(idOf('typescript', '5.4.5'), start);
    expect(added.size).toBe(2);
    expect(toggleItem(idOf('react', '19.2.8'), added).size).toBe(1);
    expect(start.size).toBe(1);
  });

  it('totals what is picked, and what removing it would really free', () => {
    const shared = provider('bun', {
      items: [item('a', '1.0.0', 100, { sharedBytes: 40 }), item('a', '2.0.0', 500)],
    });
    const everything = new Set(shared.items.map((entry) => entry.id));
    expect(selectionTotals(shared, everything)).toEqual({
      count: 2,
      bytes: 600,
      freesUpTo: 560,
      groups: 1,
    });
    expect(selectionTotals(shared, new Set())).toEqual({
      count: 0,
      bytes: 0,
      freesUpTo: 0,
      groups: 0,
    });
  });

  it('ignores an id that is not in the scan', () => {
    expect(selectionTotals(bun, new Set(['nope'])).count).toBe(0);
  });
});
