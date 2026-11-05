import type { ProviderScan, ScanItem } from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  allOldVersionsConfirm,
  commandConfirm,
  everythingConfirm,
  itemsConfirm,
  oldVersionsConfirm,
} from './confirm';

let counter = 0;
function item(group: string, version: string | null, bytes: number, shared = 0): ScanItem {
  counter += 1;
  return {
    id: `i${counter}`,
    group,
    groupLabel: group,
    version,
    bytes,
    sharedBytes: shared,
    files: 1,
    newestMs: 1,
  };
}

function provider(items: ScanItem[], overrides: Partial<ProviderScan> = {}): ProviderScan {
  return {
    id: 'nuget',
    label: 'NuGet',
    tagline: '.NET packages',
    kind: 'versioned',
    status: 'ready',
    root: 'C:\\Users\\me\\.nuget\\packages',
    bytes: items.reduce((sum, entry) => sum + entry.bytes, 0),
    files: items.length,
    sharedBytes: 0,
    unreadable: 0,
    items,
    clearCommand: null,
    tidyCommand: null,
    afterClearing: 'The next restore downloads the packages a project needs again.',
    ...overrides,
  };
}

const MB = 1024 * 1024;

describe('oldVersionsConfirm', () => {
  const nuget = provider([
    item('acornima', '1.0.0', 10 * MB),
    item('acornima', '2.0.0', 20 * MB),
    item('acornima', '3.0.0', 40 * MB),
    item('sass', '1.0.0', 5 * MB),
    item('sass', '1.1.0', 6 * MB),
    item('solo', '1.0.0', 99 * MB),
  ]);

  it('says what is removed and what it frees, in numbers', () => {
    const confirm = oldVersionsConfirm(nuget, 1);
    expect(confirm?.title).toBe('Remove old versions from NuGet?');
    expect(confirm?.description).toContain('3 versions');
    expect(confirm?.description).toContain('2 packages');
    expect(confirm?.description).toContain('frees up to 35.0 MB');
    expect(confirm?.confirmLabel).toBe('Free 35.0 MB');
  });

  it('says how many are kept', () => {
    expect(oldVersionsConfirm(nuget, 1)?.description).toMatch(
      /newest version of each package stays/i,
    );
    expect(oldVersionsConfirm(nuget, 2)?.description).toMatch(
      /newest 2 versions of each package stay/i,
    );
  });

  it('says it is permanent and warns about builds and what newest means', () => {
    const confirm = oldVersionsConfirm(nuget, 1);
    expect(confirm?.description).toMatch(/deleted for good/i);
    expect(confirm?.warning).toContain(
      'The next restore downloads the packages a project needs again.',
    );
    expect(confirm?.warning).toMatch(/close running builds/i);
    expect(confirm?.warning).toMatch(/highest version number/i);
  });

  it('lists the biggest things going, and counts the rest', () => {
    const many = provider(
      Array.from({ length: 10 }, (_, index) => [
        item(`pkg${index}`, '1.0.0', (index + 1) * MB),
        item(`pkg${index}`, '2.0.0', 50 * MB),
      ]).flat(),
    );
    const confirm = oldVersionsConfirm(many, 1);
    expect(confirm?.items).toHaveLength(6);
    expect(confirm?.items?.[0]).toMatchObject({
      name: 'pkg9',
      detail: '1.0.0, 10.0 MB',
      isDirectory: true,
    });
    expect(confirm?.moreCount).toBe(4);
  });

  it('counts only what would really be freed when some of it is shared', () => {
    const shared = provider([item('a', '1.0.0', 100 * MB, 40 * MB), item('a', '2.0.0', 100 * MB)]);
    expect(oldVersionsConfirm(shared, 1)?.description).toContain('frees up to 60.0 MB');
  });

  it('has nothing to say when nothing would be removed', () => {
    expect(oldVersionsConfirm(provider([item('a', '1.0.0', MB)]), 1)).toBeNull();
  });
});

describe('everythingConfirm', () => {
  const nuget = provider([
    item('acornima', '1.0.0', 10 * MB),
    item('acornima', '2.0.0', 20 * MB),
    item('sass', '1.0.0', 5 * MB),
  ]);

  it('names the cache and the folder, and what it frees', () => {
    const confirm = everythingConfirm(nuget);
    expect(confirm.title).toBe('Clear all of NuGet?');
    expect(confirm.description).toContain('C:\\Users\\me\\.nuget\\packages');
    expect(confirm.description).toContain('frees up to 35.0 MB');
    expect(confirm.description).toMatch(/deleted for good/i);
    expect(confirm.confirmLabel).toBe('Clear 35.0 MB');
  });

  it('lists the packages that make up most of it', () => {
    const confirm = everythingConfirm(nuget);
    expect(confirm.items?.[0]).toMatchObject({ name: 'acornima', detail: '2 versions, 30.0 MB' });
    expect(confirm.items?.[1]).toMatchObject({ name: 'sass', detail: '1 version, 5.00 MB' });
  });

  it('carries the same caution about builds', () => {
    expect(everythingConfirm(nuget).warning).toMatch(/close running builds/i);
  });
});

describe('itemsConfirm', () => {
  const nuget = provider([
    item('acornima', '1.0.0', 10 * MB),
    item('acornima', '2.0.0', 20 * MB),
    item('sass', '1.0.0', 5 * MB),
  ]);

  it('counts what was picked', () => {
    const picked = new Set([nuget.items[0]?.id ?? '', nuget.items[2]?.id ?? '']);
    const confirm = itemsConfirm(nuget, picked);
    expect(confirm?.title).toBe('Delete 2 items?');
    expect(confirm?.description).toContain('frees up to 15.0 MB');
    expect(confirm?.confirmLabel).toBe('Delete 15.0 MB');
  });

  it('says one item in the singular', () => {
    expect(itemsConfirm(nuget, new Set([nuget.items[1]?.id ?? '']))?.title).toBe('Delete 1 item?');
  });

  it('has nothing to say when nothing was picked', () => {
    expect(itemsConfirm(nuget, new Set())).toBeNull();
  });
});

describe('commandConfirm', () => {
  const npm = provider([], {
    id: 'npm',
    label: 'npm',
    kind: 'opaque',
    bytes: 900 * MB,
    root: '/home/me/.npm/_cacache',
    afterClearing: 'The next npm install downloads the packages it needs again.',
  });

  it('says it runs the tool, shows the command and what the cache holds now', () => {
    const confirm = commandConfirm(npm, {
      kind: 'clear-command',
      label: 'npm cache clean --force',
    });
    expect(confirm.title).toBe('Clean npm with its own tool?');
    expect(confirm.description).toContain('npm cache clean --force');
    expect(confirm.description).toContain('900 MB');
    expect(confirm.items).toEqual([{ name: 'npm cache clean --force', isDirectory: false }]);
    expect(confirm.warning).toContain(
      'The next npm install downloads the packages it needs again.',
    );
    expect(confirm.confirmLabel).toBe('Run it');
  });

  it('explains that a prune only removes what nothing uses', () => {
    const confirm = commandConfirm(npm, { kind: 'tidy', label: 'pnpm store prune' });
    expect(confirm.description).toMatch(/nothing uses|no longer used|unused/i);
  });
});

describe('allOldVersionsConfirm', () => {
  const nuget = provider([
    item('a', '1.0.0', 10 * MB),
    item('a', '2.0.0', 20 * MB),
    item('b', '1.0.0', 5 * MB),
    item('b', '2.0.0', 5 * MB),
  ]);
  const bun = provider([item('react', '1.0.0', 30 * MB), item('react', '2.0.0', 30 * MB)], {
    id: 'bun',
    label: 'Bun',
    afterClearing: 'The next bun install downloads what it needs again.',
  });

  it('asks once for every cache that has something old', () => {
    const confirm = allOldVersionsConfirm([nuget, bun], 1);
    expect(confirm?.title).toBe('Remove old versions from 2 caches?');
    expect(confirm?.description).toContain('3 versions of 3 packages');
    expect(confirm?.description).toContain('frees up to 45.0 MB');
    expect(confirm?.confirmLabel).toBe('Free 45.0 MB');
  });

  it('lists each cache with what goes from it, biggest first', () => {
    const confirm = allOldVersionsConfirm([nuget, bun], 1);
    expect(confirm?.items).toEqual([
      { name: 'Bun', detail: '1 version, 30.0 MB', isDirectory: true },
      { name: 'NuGet', detail: '2 versions, 15.0 MB', isDirectory: true },
    ]);
  });

  it('names the one cache when only one has something old', () => {
    const tidy = provider([item('x', '1.0.0', MB)], { id: 'cargo', label: 'Cargo' });
    const confirm = allOldVersionsConfirm([nuget, tidy], 1);
    expect(confirm?.title).toBe('Remove old versions from NuGet?');
  });

  it('carries the cautions, and says it is permanent', () => {
    const confirm = allOldVersionsConfirm([nuget, bun], 1);
    expect(confirm?.description).toMatch(/deleted for good/i);
    expect(confirm?.warning).toMatch(/close running builds/i);
    expect(confirm?.warning).toMatch(/highest version number/i);
  });

  it('has nothing to say when no cache has anything old', () => {
    expect(allOldVersionsConfirm([provider([item('a', '1.0.0', MB)])], 1)).toBeNull();
    expect(allOldVersionsConfirm([], 1)).toBeNull();
  });
});

describe('the wording', () => {
  it('has no em dash anywhere', () => {
    const p = provider([item('a', '1.0.0', MB), item('a', '2.0.0', MB)]);
    const all = [
      oldVersionsConfirm(p, 1),
      everythingConfirm(p),
      itemsConfirm(p, new Set([p.items[0]?.id ?? ''])),
      commandConfirm(p, { kind: 'clear-command', label: 'x' }),
      commandConfirm(p, { kind: 'tidy', label: 'y' }),
      allOldVersionsConfirm([p, p], 1),
    ];
    for (const confirm of all) expect(JSON.stringify(confirm)).not.toContain('\u2014');
  });
});
