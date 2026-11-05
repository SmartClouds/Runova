import { existsSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CacheProviderId,
  CleanSelection,
  DevOs,
  SafetyContext,
  SystemCleanEvent,
} from '@runova/core';
import { getProvider } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import type { ResolvedLocation } from '../locations';
import { type CleanDeps, CleanRefused, type DeletionLogEntry, runClean } from './cleaner';
import { type LiveScan, runScan } from './scanner';

const bytes = (count: number): string => 'x'.repeat(count);

const os: DevOs =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

function safetyFor(): SafetyContext {
  return { os, home: realpathSync(tempDir()), protectedFolders: [], projectFolders: [] };
}

function located(
  id: CacheProviderId,
  root: string,
  tools = { clear: false, tidy: false },
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

async function scanned(
  id: CacheProviderId,
  files: Record<string, string>,
  tools = { clear: false, tidy: false },
): Promise<{ root: string; live: LiveScan }> {
  const root = realpathSync(writeTree(tempDir(), files));
  const live = await runScan(
    {
      locations: [located(id, root, tools)],
      newScanId: () => 'scan-1',
      now: () => 1,
      progressGapMs: 0,
    },
    { requestId: 'scan', onEvent: () => undefined },
  );
  return { root, live };
}

interface Harness {
  deps: CleanDeps;
  logged: DeletionLogEntry[];
  events: SystemCleanEvent[];
  commands: string[];
}

function harness(live: LiveScan, extra: Partial<CleanDeps> = {}): Harness {
  const logged: DeletionLogEntry[] = [];
  const commands: string[] = [];
  const deps: CleanDeps = {
    live,
    safety: safetyFor(),
    now: () => 5,
    sleep: async () => undefined,
    log: async (entry) => {
      logged.push(entry);
    },
    runCommand: async (action, onLine) => {
      commands.push([action.command, ...action.args].join(' '));
      onLine('working');
      return { code: 0, cancelled: false, notFound: false, timedOut: false };
    },
    ...extra,
  };
  return { deps, logged, events: [], commands };
}

async function clean(
  h: Harness,
  selection: CleanSelection,
  options: { scanId?: string; signal?: AbortSignal } = {},
) {
  return runClean(h.deps, {
    requestId: 'c1',
    scanId: options.scanId ?? 'scan-1',
    selection,
    signal: options.signal,
    onEvent: (event) => h.events.push(event),
  });
}

const NUGET = {
  'acornima/1.0.0/a.nupkg': bytes(10),
  'acornima/1.0.0/.nupkg.metadata': bytes(5),
  'acornima/2.0.0/a.nupkg': bytes(20),
  'acornima/2.0.0/.nupkg.metadata': bytes(5),
  'acornima/3.0.0/a.nupkg': bytes(40),
  'sass/1.1.52/s.nupkg': bytes(30),
};

describe('runClean, old versions', () => {
  it('removes every version but the newest, and leaves the rest on disk', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const h = harness(live);
    const result = await clean(h, { mode: 'old-versions', providerId: 'nuget', keep: 1 });

    expect(existsSync(join(root, 'acornima', '1.0.0'))).toBe(false);
    expect(existsSync(join(root, 'acornima', '2.0.0'))).toBe(false);
    expect(existsSync(join(root, 'acornima', '3.0.0', 'a.nupkg'))).toBe(true);
    expect(existsSync(join(root, 'sass', '1.1.52', 's.nupkg'))).toBe(true);
    expect(result).toMatchObject({
      providerId: 'nuget',
      removed: 2,
      freedBytes: 40,
      cancelled: false,
    });
    expect(result.failed).toEqual([]);
  });

  it('keeps the newest few when asked to', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const result = await clean(harness(live), {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 2,
    });
    expect(existsSync(join(root, 'acornima', '1.0.0'))).toBe(false);
    expect(existsSync(join(root, 'acornima', '2.0.0'))).toBe(true);
    expect(result.removed).toBe(1);
  });

  it('reports each step as it goes', async () => {
    const { live } = await scanned('nuget', NUGET);
    const h = harness(live);
    await clean(h, { mode: 'old-versions', providerId: 'nuget', keep: 1 });
    expect(h.events.map((event) => event.type)).toEqual([
      'started',
      'item-done',
      'item-done',
      'finished',
    ]);
    expect(h.events[0]).toMatchObject({
      type: 'started',
      providerId: 'nuget',
      total: 2,
      bytes: 40,
    });
    expect(h.events.at(-1)).toEqual({
      type: 'finished',
      requestId: 'c1',
      providerId: 'nuget',
      cancelled: false,
    });
  });

  it('writes down what it removed, since it cannot be undone', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const h = harness(live);
    await clean(h, { mode: 'old-versions', providerId: 'nuget', keep: 1 });
    expect(
      h.logged
        .map((entry) => entry.paths)
        .flat()
        .sort(),
    ).toEqual([join(root, 'acornima', '1.0.0'), join(root, 'acornima', '2.0.0')].sort());
    expect(h.logged.every((entry) => entry.providerId === 'nuget' && entry.at === 5)).toBe(true);
    expect(h.logged.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(40);
  });

  it('removes the package folder once its last version is gone, and not before', async () => {
    const { root, live } = await scanned('nuget', {
      'gone/1.0.0/a.nupkg': bytes(5),
      'gone/2.0.0/a.nupkg': bytes(5),
      ...NUGET,
    });
    await clean(harness(live), {
      mode: 'items',
      providerId: 'nuget',
      itemIds: itemIds(live, 'gone'),
    });
    expect(existsSync(join(root, 'gone'))).toBe(false);
    expect(existsSync(join(root, 'acornima'))).toBe(true);
  });

  it('brings the scan up to date, so the window need not scan again', async () => {
    const { live } = await scanned('nuget', NUGET);
    const before = live.providers.get('nuget')?.scan.bytes ?? 0;
    const result = await clean(harness(live), {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 1,
    });
    expect(result.provider.bytes).toBe(before - 40);
    expect(result.provider.items.map((item) => `${item.group}@${item.version}`).sort()).toEqual([
      'acornima@3.0.0',
      'sass@1.1.52',
    ]);
    expect(live.providers.get('nuget')?.items.size).toBe(2);
  });

  it('leaves alone a group whose versions it cannot order, and says so', async () => {
    const { root, live } = await scanned('nuget', {
      'odd/1.0.0/a.nupkg': bytes(5),
      'odd/2.0.0/a.nupkg': bytes(5),
      'odd/LATEST/a.nupkg': bytes(5),
      ...NUGET,
    });
    const result = await clean(harness(live), {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 1,
    });
    expect(existsSync(join(root, 'odd', '1.0.0'))).toBe(true);
    expect(result.skipped).toEqual([
      { label: 'odd', reason: 'The versions could not be put in order, so none were removed.' },
    ]);
  });

  it('removes both parts of a version that lives in two places', async () => {
    const index = 'index.crates.io-abc';
    const { root, live } = await scanned('cargo', {
      [`cache/${index}/rand-0.8.4.crate`]: bytes(10),
      [`src/${index}/rand-0.8.4/lib.rs`]: bytes(20),
      [`cache/${index}/rand-0.8.5.crate`]: bytes(11),
      [`src/${index}/rand-0.8.5/lib.rs`]: bytes(21),
    });
    const result = await clean(harness(live), {
      mode: 'old-versions',
      providerId: 'cargo',
      keep: 1,
    });
    expect(existsSync(join(root, 'cache', index, 'rand-0.8.4.crate'))).toBe(false);
    expect(existsSync(join(root, 'src', index, 'rand-0.8.4'))).toBe(false);
    expect(existsSync(join(root, 'cache', index, 'rand-0.8.5.crate'))).toBe(true);
    expect(existsSync(join(root, 'src', index, 'rand-0.8.5', 'lib.rs'))).toBe(true);
    expect(result.freedBytes).toBe(30);
  });
});

function itemIds(live: LiveScan, group: string): string[] {
  return [...(live.providers.get('nuget')?.items.values() ?? [])]
    .filter((entry) => entry.item.group === group)
    .map((entry) => entry.id);
}

describe('runClean, everything', () => {
  it('removes everything the scan found, versioned or not', async () => {
    const { root, live } = await scanned('nuget', { ...NUGET, '.tools/x/y.bin': bytes(7) });
    const result = await clean(harness(live), { mode: 'everything', providerId: 'nuget' });
    expect(existsSync(join(root, 'acornima'))).toBe(false);
    expect(existsSync(join(root, 'sass'))).toBe(false);
    expect(existsSync(join(root, '.tools'))).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(result.freedBytes).toBe(117);
  });
});

describe('runClean, chosen items', () => {
  it('removes just the items picked', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    await clean(harness(live), {
      mode: 'items',
      providerId: 'nuget',
      itemIds: itemIds(live, 'sass'),
    });
    expect(existsSync(join(root, 'sass'))).toBe(false);
    expect(existsSync(join(root, 'acornima', '3.0.0'))).toBe(true);
  });

  it('refuses the whole request, and removes nothing, if it names something the scan did not find', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    await expect(
      clean(harness(live), {
        mode: 'items',
        providerId: 'nuget',
        itemIds: [...itemIds(live, 'sass'), 'made-up'],
      }),
    ).rejects.toThrow(CleanRefused);
    expect(existsSync(join(root, 'sass', '1.1.52'))).toBe(true);
  });
});

describe('runClean, requests it must refuse', () => {
  it('refuses a scan that is not the current one', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    await expect(
      clean(
        harness(live),
        { mode: 'everything', providerId: 'nuget' },
        { scanId: 'some-old-scan' },
      ),
    ).rejects.toThrow(/scan again|out of date/i);
    expect(existsSync(join(root, 'sass'))).toBe(true);
  });

  it('refuses a cache the scan did not find', async () => {
    const { live } = await scanned('nuget', NUGET);
    await expect(clean(harness(live), { mode: 'everything', providerId: 'bun' })).rejects.toThrow(
      CleanRefused,
    );
  });

  it('refuses a cache whose layout was not recognised', async () => {
    const { root, live } = await scanned('nuget', { 'Website/src/index.html': bytes(5) });
    await expect(clean(harness(live), { mode: 'everything', providerId: 'nuget' })).rejects.toThrow(
      CleanRefused,
    );
    expect(existsSync(join(root, 'Website'))).toBe(true);
  });

  it('refuses to delete inside a cache that only its tool cleans', async () => {
    const { live } = await scanned('npm', { 'a/b': bytes(5) });
    await expect(clean(harness(live), { mode: 'everything', providerId: 'npm' })).rejects.toThrow(
      CleanRefused,
    );
    await expect(
      clean(harness(live), { mode: 'old-versions', providerId: 'npm', keep: 1 }),
    ).rejects.toThrow(CleanRefused);
  });

  it('refuses to prune by version a cache that has none', async () => {
    const { live } = await scanned('nuget', NUGET);
    await expect(clean(harness(live), { mode: 'tidy', providerId: 'nuget' })).rejects.toThrow(
      CleanRefused,
    );
  });

  it('removes nothing that is outside the cache folder, whatever the scan says', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const outside = realpathSync(writeTree(tempDir(), { 'precious/1.0.0/keep.txt': 'keep' }));
    const provider = live.providers.get('nuget');
    const first = provider ? [...provider.items.values()][0] : undefined;
    if (first) first.paths = [join(outside, 'precious', '1.0.0')];
    const h = harness(live);
    const result = await clean(h, { mode: 'everything', providerId: 'nuget' });
    expect(existsSync(join(outside, 'precious', '1.0.0', 'keep.txt'))).toBe(true);
    expect(result.failed.some((failure) => /outside the cache/i.test(failure.reason))).toBe(true);
    expect(existsSync(join(root, 'sass'))).toBe(false);
  });
});

describe('runClean, when things go wrong', () => {
  it('carries on past an item that will not go, and says which and why', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const h = harness(live, {
      remove: async (path, options) => {
        if (path.includes(`${join('acornima', '1.0.0')}`)) {
          return { status: 'in-use', reason: 'It is in use by another program.' };
        }
        const { removeItem } = await import('./removeTree');
        return removeItem(path, options);
      },
    });
    const result = await clean(h, { mode: 'old-versions', providerId: 'nuget', keep: 1 });
    expect(existsSync(join(root, 'acornima', '1.0.0'))).toBe(true);
    expect(existsSync(join(root, 'acornima', '2.0.0'))).toBe(false);
    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBe(25);
    expect(result.failed).toEqual([
      {
        itemId: expect.any(String),
        label: 'acornima 1.0.0',
        reason: 'It is in use by another program.',
      },
    ]);
    expect(h.events.some((event) => event.type === 'item-failed')).toBe(true);
  });

  it('leaves an item alone if it changed after the scan, because something may be using it', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const changed = join(root, 'acornima', '1.0.0');
    writeFileSync(join(changed, 'new-file.bin'), 'a tool just wrote this');
    utimesSync(changed, new Date(), new Date(Date.now() + 60_000));
    const result = await clean(harness(live), {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 1,
    });
    expect(existsSync(join(changed, 'new-file.bin'))).toBe(true);
    expect(result.failed[0]?.reason).toMatch(/changed after the scan/i);
    expect(existsSync(join(root, 'acornima', '2.0.0'))).toBe(false);
  });

  it('counts an item that has already gone as done, without claiming the space', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const { rmSync } = await import('node:fs');
    rmSync(join(root, 'acornima', '1.0.0'), { recursive: true });
    const result = await clean(harness(live), {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 1,
    });
    expect(result.failed).toEqual([]);
    expect(result.removed).toBe(2);
    expect(result.freedBytes).toBe(25);
  });

  it('stops between items when cancelled, and leaves the rest untouched', async () => {
    const { root, live } = await scanned('nuget', NUGET);
    const controller = new AbortController();
    const h = harness(live);
    const original = h.deps.log;
    h.deps.log = async (entry) => {
      await original(entry);
      controller.abort();
    };
    const result = await clean(
      h,
      { mode: 'old-versions', providerId: 'nuget', keep: 1 },
      { signal: controller.signal },
    );
    expect(result.cancelled).toBe(true);
    expect(result.removed).toBe(1);
    const left = ['1.0.0', '2.0.0'].filter((version) =>
      existsSync(join(root, 'acornima', version)),
    );
    expect(left).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ type: 'finished', cancelled: true });
  });
});

describe("runClean, a tool's own command", () => {
  it('runs the command for a cache only its tool cleans, and shows what it prints', async () => {
    const { live, root } = await scanned('npm', { 'content/a': bytes(100), 'index/b': bytes(50) });
    const provider = live.providers.get('npm');
    if (provider) provider.scan.clearCommand = { label: 'npm cache clean --force' };
    const h = harness(live, {
      runCommand: async (action, onLine) => {
        h.commands.push([action.command, ...action.args].join(' '));
        onLine('removed it all');
        const { rmSync } = await import('node:fs');
        rmSync(join(root, 'content'), { recursive: true });
        return { code: 0, cancelled: false, notFound: false, timedOut: false };
      },
    });
    const result = await clean(h, { mode: 'clear-command', providerId: 'npm' });
    expect(h.commands).toEqual(['npm cache clean --force']);
    expect(h.events.some((event) => event.type === 'line' && event.text === 'removed it all')).toBe(
      true,
    );
    expect(result.freedBytes).toBe(100);
    expect(result.provider.bytes).toBe(50);
    expect(result.failed).toEqual([]);
  });

  it('runs the tidy command for a store that is pruned', async () => {
    const { live } = await scanned('pnpm', { 'files/a': bytes(10) }, { clear: false, tidy: true });
    const h = harness(live);
    await clean(h, { mode: 'tidy', providerId: 'pnpm' });
    expect(h.commands).toEqual(['pnpm store prune']);
  });

  it('reports a command that fails, with its exit code', async () => {
    const { live } = await scanned('npm', { 'a/b': bytes(5) }, { clear: true, tidy: false });
    const h = harness(live, {
      runCommand: async () => ({ code: 3, cancelled: false, notFound: false, timedOut: false }),
    });
    const result = await clean(h, { mode: 'clear-command', providerId: 'npm' });
    expect(result.failed).toEqual([
      {
        itemId: null,
        label: 'npm cache clean --force',
        reason: 'The command stopped with an error (exit code 3).',
      },
    ]);
    expect(result.freedBytes).toBe(0);
  });

  it('reports a tool that cannot be found, and one that took too long', async () => {
    const { live } = await scanned('npm', { 'a/b': bytes(5) }, { clear: true, tidy: false });
    const missing = await clean(
      harness(live, {
        runCommand: async () => ({ code: null, cancelled: false, notFound: true, timedOut: false }),
      }),
      { mode: 'clear-command', providerId: 'npm' },
    );
    expect(missing.failed[0]?.reason).toMatch(/not installed|could not be found/i);
    const slow = await clean(
      harness(live, {
        runCommand: async () => ({ code: null, cancelled: false, notFound: false, timedOut: true }),
      }),
      { mode: 'clear-command', providerId: 'npm' },
    );
    expect(slow.failed[0]?.reason).toMatch(/too long/i);
  });

  it('refuses a command the tool is not installed to run', async () => {
    const { live } = await scanned('npm', { 'a/b': bytes(5) });
    await expect(
      clean(harness(live), { mode: 'clear-command', providerId: 'npm' }),
    ).rejects.toThrow(CleanRefused);
  });

  it('stops the command when cancelled and says so', async () => {
    const { live } = await scanned('npm', { 'a/b': bytes(5) }, { clear: true, tidy: false });
    const controller = new AbortController();
    const result = await clean(
      harness(live, {
        runCommand: async () => {
          controller.abort();
          return { code: null, cancelled: true, notFound: false, timedOut: false };
        },
      }),
      { mode: 'clear-command', providerId: 'npm' },
      { signal: controller.signal },
    );
    expect(result.cancelled).toBe(true);
  });
});
