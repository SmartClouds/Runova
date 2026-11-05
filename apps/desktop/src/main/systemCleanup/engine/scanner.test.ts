import { linkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type CacheProviderId, getProvider, type SystemScanEvent, TRASH_MARK } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import type { ResolvedLocation } from '../locations';
import { measurePath } from './measure';
import { publicScan, runScan, type ScanDeps } from './scanner';

const bytes = (count: number): string => 'x'.repeat(count);

function folder(files: Record<string, string> = {}): string {
  return realpathSync(writeTree(tempDir(), files));
}

function located(
  id: CacheProviderId,
  root: string,
  tools: { clear: boolean; tidy: boolean } = { clear: false, tidy: false },
): ResolvedLocation {
  return {
    provider: getProvider(id),
    status: 'found',
    root,
    realRoot: root,
    source: 'default',
    tools,
  };
}

function missing(id: CacheProviderId): ResolvedLocation {
  return {
    provider: getProvider(id),
    status: 'missing',
    root: null,
    realRoot: null,
    source: null,
    tools: { clear: false, tidy: false },
  };
}

function refused(id: CacheProviderId, reason: string): ResolvedLocation {
  return { ...missing(id), status: 'refused', reason };
}

function deps(locations: ResolvedLocation[], extra: Partial<ScanDeps> = {}): ScanDeps {
  let counter = 0;
  return {
    locations,
    newScanId: () => `scan-${++counter}`,
    now: () => 1_000,
    progressGapMs: 0,
    ...extra,
  };
}

async function scan(
  d: ScanDeps,
  signal?: AbortSignal,
): Promise<{ live: Awaited<ReturnType<typeof runScan>>; events: SystemScanEvent[] }> {
  const events: SystemScanEvent[] = [];
  const live = await runScan(d, { requestId: 'r1', signal, onEvent: (e) => events.push(e) });
  return { live, events };
}

const NUGET_TREE = {
  'acornima/1.0.0/acornima.1.0.0.nupkg': bytes(10),
  'acornima/1.0.0/.nupkg.metadata': bytes(5),
  'acornima/2.0.0/acornima.2.0.0.nupkg': bytes(20),
  'acornima/2.0.0/.nupkg.metadata': bytes(5),
  'sass/1.1.52/sass.1.1.52.nupkg': bytes(30),
};

describe('runScan, a cache with versions', () => {
  it('lists each version with its size, and totals the cache', async () => {
    const root = folder(NUGET_TREE);
    const { live } = await scan(deps([located('nuget', root)]));
    const provider = publicScan(live).providers[0];
    expect(provider).toMatchObject({
      id: 'nuget',
      status: 'ready',
      kind: 'versioned',
      bytes: 70,
      files: 5,
      root,
    });
    const found = provider?.items.map((item) => `${item.group}@${item.version}=${item.bytes}`);
    expect(found?.sort()).toEqual(['acornima@1.0.0=15', 'acornima@2.0.0=25', 'sass@1.1.52=30']);
  });

  it('gives every item an id of its own and remembers where it is, as full paths inside the cache', async () => {
    const root = folder(NUGET_TREE);
    const { live } = await scan(deps([located('nuget', root)]));
    const provider = live.providers.get('nuget');
    const ids = provider ? [...provider.items.keys()] : [];
    expect(new Set(ids).size).toBe(3);
    for (const entry of provider?.items.values() ?? []) {
      for (const path of entry.paths) expect(path.startsWith(root)).toBe(true);
      expect(entry.stamps.map((stamp) => stamp.path)).toEqual(entry.paths);
      expect(entry.stamps.every((stamp) => stamp.mtimeMs > 0)).toBe(true);
    }
  });

  it('keeps an item with no version, and reports the size of what it holds', async () => {
    const root = folder({ ...NUGET_TREE, '.tools/thing/x.bin': bytes(100) });
    const { live } = await scan(deps([located('nuget', root)]));
    const provider = publicScan(live).providers[0];
    expect(provider?.bytes).toBe(170);
    expect(provider?.items.find((item) => item.version === null)).toMatchObject({
      group: 'other',
      bytes: 100,
    });
  });

  it('counts a hard-linked file as shared, because deleting one name frees nothing', async () => {
    const root = folder({ ...NUGET_TREE, 'pnpmish/1.0.0/a.nupkg': bytes(50) });
    try {
      linkSync(
        join(root, 'pnpmish', '1.0.0', 'a.nupkg'),
        join(root, 'pnpmish', '1.0.0', 'b.nupkg'),
      );
    } catch {
      return; // This filesystem cannot make hard links.
    }
    const { live } = await scan(deps([located('nuget', root)]));
    const item = publicScan(live).providers[0]?.items.find((entry) => entry.group === 'pnpmish');
    expect(item?.sharedBytes).toBe(100);
    expect(publicScan(live).providers[0]?.sharedBytes).toBe(100);
  });

  it('calls a folder that is not laid out like this cache unverified, and offers nothing from it', async () => {
    const root = folder({
      'Website/src/index.html': bytes(40),
      'Notes/2024/jan.txt': bytes(10),
    });
    const { live } = await scan(deps([located('nuget', root)]));
    const provider = publicScan(live).providers[0];
    expect(provider).toMatchObject({ status: 'unverified', bytes: 50, items: [] });
    expect(provider?.error).toMatch(/not laid out|recogni/i);
    expect(live.providers.get('nuget')?.items.size).toBe(0);
  });

  it('calls a folder with only unrecognised files unverified too', async () => {
    const root = folder({ 'readme.txt': bytes(10), 'notes/a.txt': bytes(10) });
    const { live } = await scan(deps([located('playwright', root)]));
    expect(publicScan(live).providers[0]?.status).toBe('unverified');
  });

  it('is ready, and empty, for an empty cache', async () => {
    const root = folder();
    const { live } = await scan(deps([located('nuget', root)]));
    expect(publicScan(live).providers[0]).toMatchObject({ status: 'ready', bytes: 0, items: [] });
  });

  it('does not list a folder a clean-up set aside, and remembers it to finish later', async () => {
    const root = folder({
      ...NUGET_TREE,
      [`acornima/1.0.0${TRASH_MARK}abc123/old.bin`]: bytes(999),
    });
    const { live } = await scan(deps([located('nuget', root)]));
    const provider = live.providers.get('nuget');
    expect(provider?.scan.bytes).toBe(70);
    expect(provider?.leftovers).toEqual([join(root, 'acornima', `1.0.0${TRASH_MARK}abc123`)]);
  });
});

describe('runScan, a cache only its tool cleans', () => {
  it('measures it as a whole and lists no items', async () => {
    const root = folder({ 'index-v5/a': bytes(100), 'content-v2/b': bytes(200) });
    const { live } = await scan(deps([located('npm', root, { clear: true, tidy: false })]));
    expect(publicScan(live).providers[0]).toMatchObject({
      id: 'npm',
      kind: 'opaque',
      status: 'ready',
      bytes: 300,
      files: 2,
      items: [],
      clearCommand: { label: 'npm cache clean --force' },
      tidyCommand: null,
    });
  });

  it('offers no command when the tool that would run it is not installed', async () => {
    const root = folder({ a: bytes(1) });
    const { live } = await scan(deps([located('npm', root)]));
    expect(publicScan(live).providers[0]).toMatchObject({ clearCommand: null, tidyCommand: null });
  });

  it('offers the tidy command for a store that is pruned', async () => {
    const root = folder({ a: bytes(1) });
    const { live } = await scan(deps([located('pnpm', root, { clear: false, tidy: true })]));
    expect(publicScan(live).providers[0]?.tidyCommand).toEqual({ label: 'pnpm store prune' });
  });
});

describe('runScan, caches that are not there or may not be used', () => {
  it('reports a cache that is missing', async () => {
    const { live } = await scan(deps([missing('bun')]));
    expect(publicScan(live).providers[0]).toMatchObject({
      id: 'bun',
      status: 'missing',
      root: null,
      bytes: 0,
    });
  });

  it('reports a refused folder without reading it', async () => {
    let measured = 0;
    const { live } = await scan(
      deps([refused('nuget', 'That is your home folder.')], {
        measure: async (...args) => {
          measured += 1;
          return measurePath(...args);
        },
      }),
    );
    expect(measured).toBe(0);
    expect(publicScan(live).providers[0]).toMatchObject({
      status: 'unverified',
      error: 'That is your home folder.',
      bytes: 0,
    });
  });
});

describe('runScan, events', () => {
  it('tells the window which caches it will look at, then each one in turn, then that it is done', async () => {
    const a = folder({ 'x/1.0.0/a.nupkg': bytes(5) });
    const { events } = await scan(
      deps([located('nuget', a), missing('bun')], { providerConcurrency: 1 }),
    );
    expect(events[0]).toMatchObject({
      type: 'started',
      requestId: 'r1',
      scanId: 'scan-1',
      providers: [
        { id: 'nuget', label: 'NuGet' },
        { id: 'bun', label: 'Bun' },
      ],
    });
    expect(events.map((event) => event.type)).toEqual([
      'started',
      'provider-started',
      'provider-done',
      'provider-started',
      'provider-done',
      'finished',
    ]);
    expect(events.at(-1)).toEqual({ type: 'finished', requestId: 'r1', cancelled: false });
  });

  it('reports bytes and files as it reads, never going backwards', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 300; index += 1) files[`blob/f${index}.bin`] = bytes(10);
    const root = folder(files);
    const { events } = await scan(deps([located('npm', root)], { progressEveryFiles: 50 }));
    const progress = events.filter((event) => event.type === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < progress.length; index += 1) {
      const before = progress[index - 1];
      const after = progress[index];
      if (before?.type === 'progress' && after?.type === 'progress') {
        expect(after.bytes).toBeGreaterThanOrEqual(before.bytes);
        expect(after.files).toBeGreaterThanOrEqual(before.files);
      }
    }
  });

  it('sends the finished answer for a cache with its items', async () => {
    const root = folder(NUGET_TREE);
    const { events } = await scan(deps([located('nuget', root)]));
    const done = events.find((event) => event.type === 'provider-done');
    expect(done?.type === 'provider-done' && done.provider.items).toHaveLength(3);
  });
});

describe('runScan, cancelling', () => {
  it('stops, marks the rest as cancelled, and says it was cut short', async () => {
    const roots = [folder({ a: bytes(5) }), folder({ b: bytes(5) }), folder({ c: bytes(5) })];
    const controller = new AbortController();
    const events: SystemScanEvent[] = [];
    const live = await runScan(
      deps(
        [
          located('npm', roots[0] ?? ''),
          located('pip', roots[1] ?? ''),
          located('go-build', roots[2] ?? ''),
        ],
        { providerConcurrency: 1 },
      ),
      {
        requestId: 'r1',
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'provider-started') controller.abort();
        },
      },
    );
    expect(live.cancelled).toBe(true);
    const statuses = publicScan(live).providers.map((provider) => provider.status);
    expect(statuses).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(events.at(-1)).toEqual({ type: 'finished', requestId: 'r1', cancelled: true });
  });

  it('does not start when it is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { live } = await scan(deps([located('npm', folder({ a: bytes(1) }))]), controller.signal);
    expect(live.cancelled).toBe(true);
    expect(publicScan(live).providers[0]?.status).toBe('cancelled');
  });
});

describe('runScan, scheduling', () => {
  it('reads at most two caches at once, so a disk is not made to jump between them', async () => {
    const locations = (['npm', 'pip', 'go-build', 'pnpm', 'nuget-http'] as const).map((id) =>
      located(id, folder({ f: bytes(1) })),
    );
    let running = 0;
    let peak = 0;
    await scan(
      deps(locations, {
        measure: async (...args) => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 15));
          running -= 1;
          return measurePath(...args);
        },
      }),
    );
    expect(peak).toBe(2);
  });
});

describe('runScan, the disks', () => {
  it('adds up what the caches take on each disk, with the free space it reports', async () => {
    const a = folder({ f: bytes(100) });
    const b = folder({ g: bytes(50) });
    const { live } = await scan(
      deps([located('npm', a), located('pip', b)], {
        volumeOf: async () => ({ key: 'C:', mount: 'C:', totalBytes: 1000, freeBytes: 400 }),
      }),
    );
    expect(publicScan(live).volumes).toEqual([
      { mount: 'C:', totalBytes: 1000, freeBytes: 400, cacheBytes: 150 },
    ]);
  });

  it('leaves the disks out when they cannot be read', async () => {
    const { live } = await scan(
      deps([located('npm', folder({ f: bytes(1) }))], {
        volumeOf: async () => {
          throw new Error('no statfs');
        },
      }),
    );
    expect(publicScan(live).volumes).toEqual([]);
  });
});

describe('publicScan', () => {
  it('carries the id, the times and no path other than the cache folder to show', async () => {
    const root = folder(NUGET_TREE);
    const { live } = await scan(deps([located('nuget', root)]));
    const result = publicScan(live);
    expect(result).toMatchObject({ scanId: 'scan-1', startedAt: 1_000, cancelled: false });
    const text = JSON.stringify(result);
    expect(text).not.toContain('acornima.1.0.0.nupkg');
  });
});
