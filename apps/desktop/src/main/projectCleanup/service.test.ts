import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CleanupRemoveEvent,
  CleanupScanEvent,
  CleanupStudioVideo,
} from '../../shared/projectCleanupTypes';
import { hasGit, initGitRepo, tempDir, writeTree } from '../../test/main/fixtures';
import { type CleanupDeps, createProjectCleanup } from './service';

const bytes = (count: number): string => 'x'.repeat(count);

interface Rig {
  deps: CleanupDeps;
  root: string;
  studio: { videos: CleanupStudioVideo[]; cleared: string[][] };
  removed: string[];
}

/** A project at `root`, with whatever worktrees, locks and Studio videos a test sets up. */
function rig(
  root: string,
  over: Partial<CleanupDeps> = {},
  studioVideos: CleanupStudioVideo[] = [],
): Rig {
  const studio = { videos: studioVideos, cleared: [] as string[][] };
  const removed: string[] = [];
  const deps: CleanupDeps = {
    getProject: async (id) => (id === 'p1' ? { id: 'p1', name: 'Shop', folderPath: root } : null),
    worktrees: async () => [],
    locks: async () => [],
    studio: {
      usage: async () => studio.videos,
      clear: async (videoIds) => {
        studio.cleared.push(videoIds);
        const bytesFreed = studio.videos
          .filter((v) => videoIds.includes(v.videoId))
          .reduce((sum, v) => sum + v.bytes, 0);
        return { freedBytes: bytesFreed, cleared: videoIds, skipped: [] };
      },
    },
    removeTree: async (path) => {
      removed.push(path);
      const { rm } = await import('node:fs/promises');
      await rm(path, { recursive: true, force: true });
    },
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { deps, root, studio, removed };
}

function shop(): string {
  return writeTree(tempDir(), {
    'package.json': '{}',
    'pnpm-lock.yaml': bytes(10),
    'src/index.ts': bytes(40),
    'node_modules/dep/index.js': bytes(1000),
    'dist/main.js': bytes(300),
    '.env': 'SECRET=1',
  });
}

describe('scanning a project', () => {
  it('scans the project folder and returns what it found with the totals', async () => {
    const { deps, root } = rig(shop());
    const scan = await createProjectCleanup(deps).scan('p1', {});
    expect(scan.projectId).toBe('p1');
    expect(scan.scannedAt).toBe(1_700_000_000_000);
    expect(scan.locations).toHaveLength(1);
    const [main] = scan.locations;
    expect(main).toMatchObject({ id: 'main', path: root, isMain: true, branch: null });
    expect(main?.candidates.map((c) => c.relPath)).toEqual(['node_modules', 'dist']);
    expect(main?.totalBytes).toBeGreaterThan(1300);
  });

  it('scans each worktree as a location of its own, without counting it inside the project', async () => {
    const root = writeTree(tempDir(), {
      'package.json': '{}',
      'node_modules/a.js': bytes(100),
      '.claude/worktrees/feat/package.json': '{}',
      '.claude/worktrees/feat/node_modules/b.js': bytes(5000),
    });
    const feat = join(root, '.claude', 'worktrees', 'feat');
    const { deps } = rig(root, {
      worktrees: async () => [
        { id: 'wt1', path: feat, branch: 'feature/login', missing: false },
        { id: 'wt2', path: join(tempDir(), 'gone'), branch: 'old', missing: true },
      ],
    });
    const scan = await createProjectCleanup(deps).scan('p1', {});
    expect(scan.locations.map((l) => l.id)).toEqual(['main', 'wt1']);
    const [main, wt] = scan.locations;
    expect(main?.candidates.map((c) => c.bytes)).toEqual([100]);
    expect(wt).toMatchObject({ label: 'feature/login', branch: 'feature/login', isMain: false });
    expect(wt?.candidates.map((c) => c.bytes)).toEqual([5000]);
    expect(wt?.candidates[0]?.id).toBe('wt1:node_modules');
  });

  it('streams the locations, the folders as they are found, and the Studio cache', async () => {
    const video = { videoId: 'v1', title: 'Launch', bytes: 900, busy: false };
    const { deps } = rig(shop(), {}, [video]);
    const events: CleanupScanEvent[] = [];
    const scan = await createProjectCleanup(deps).scan('p1', {
      requestId: 'r1',
      onEvent: (event) => events.push(event),
    });
    expect(events[0]).toMatchObject({ type: 'location', locationId: 'main', requestId: 'r1' });
    const found = events.filter((e) => e.type === 'candidate').map((e) => e.candidate.relPath);
    expect(found.sort()).toEqual(['dist', 'node_modules']);
    expect(events.at(-1)).toEqual({ requestId: 'r1', type: 'studio', videos: [video] });
    expect(scan.studio).toEqual([video]);
  });

  it('still scans the folders when Studio cannot say what it holds', async () => {
    const { deps } = rig(shop(), {
      studio: {
        usage: async () => {
          throw new Error('studio is not ready');
        },
        clear: async () => ({ freedBytes: 0, cleared: [], skipped: [] }),
      },
    });
    const scan = await createProjectCleanup(deps).scan('p1', {});
    expect(scan.studio).toEqual([]);
    expect(scan.locations[0]?.candidates).toHaveLength(2);
  });

  it('locks the folders a deploy keeps in sync', async () => {
    const root = shop();
    const { deps } = rig(root, {
      locks: async () => [{ path: root, reason: 'Kept in step with the deploy site "Shop".' }],
    });
    const scan = await createProjectCleanup(deps).scan('p1', {});
    expect(scan.locations[0]?.candidates.every((c) => c.locked !== null)).toBe(true);
  });

  it('locks everything when it cannot tell which folders a deploy uses', async () => {
    const { deps } = rig(shop(), {
      locks: async () => {
        throw new Error('deploy store is unreadable');
      },
    });
    const scan = await createProjectCleanup(deps).scan('p1', {});
    const candidates = scan.locations[0]?.candidates ?? [];
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.locked?.includes('deploy'))).toBe(true);
    expect(candidates.some((c) => c.locked?.includes('unreadable'))).toBe(false);
  });

  it('refuses a project that is gone', async () => {
    const { deps } = rig(shop());
    await expect(createProjectCleanup(deps).scan('ghost', {})).rejects.toThrow(
      'That project no longer exists.',
    );
  });

  it('stops when told to', async () => {
    const { deps } = rig(shop());
    const controller = new AbortController();
    controller.abort();
    await expect(
      createProjectCleanup(deps).scan('p1', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('removing from a project', () => {
  async function scanned(r: Rig) {
    const service = createProjectCleanup(r.deps);
    const scan = await service.scan('p1', {});
    return { service, scan };
  }

  it('deletes the folders it is asked to and nothing else', async () => {
    const r = rig(shop());
    const { service } = await scanned(r);
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'dist' }],
      {},
    );
    expect(existsSync(join(r.root, 'dist'))).toBe(false);
    expect(existsSync(join(r.root, 'node_modules'))).toBe(true);
    expect(existsSync(join(r.root, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(r.root, '.env'))).toBe(true);
    expect(result).toEqual({ freedBytes: 300, removed: ['main:dist'], failed: [] });
  });

  it('reports what each one freed, less what other names still hold', async () => {
    const r = rig(shop());
    const { service } = await scanned(r);
    const events: CleanupRemoveEvent[] = [];
    await service.remove('p1', [{ kind: 'folder', locationId: 'main', relPath: 'node_modules' }], {
      requestId: 'r2',
      onEvent: (event) => events.push(event),
    });
    expect(events).toEqual([
      { requestId: 'r2', key: 'main:node_modules', status: 'removing' },
      { requestId: 'r2', key: 'main:node_modules', status: 'done', freedBytes: 1000 },
    ]);
  });

  it.each([
    ['src', 'the source'],
    ['.env', 'the environment file'],
    ['.git', 'the git history'],
    ['.runova', 'the Runova folder'],
    ['', 'the project itself'],
    ['.', 'the project itself, written another way'],
    ['../elsewhere/node_modules', 'a folder outside the project'],
    ['node_modules/../src', 'a way back out of a folder'],
    ['/etc/node_modules', 'an absolute path'],
    ['C:/Windows/node_modules', 'a drive path'],
    ['dist\\..\\src', 'a Windows way back out'],
  ])('refuses %s (%s) and deletes nothing', async (relPath) => {
    const r = rig(shop());
    const { service } = await scanned(r);
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath }],
      {},
    );
    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(r.root, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(r.root, '.env'))).toBe(true);
  });

  it('refuses a generic folder that nothing beside it explains', async () => {
    const root = writeTree(tempDir(), { 'dist/page.html': bytes(100), 'index.html': 'x' });
    const r = rig(root);
    const result = await createProjectCleanup(r.deps).remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'dist' }],
      {},
    );
    expect(result.failed).toHaveLength(1);
    expect(existsSync(join(root, 'dist', 'page.html'))).toBe(true);
  });

  it('refuses a folder that is locked by a deploy', async () => {
    const root = shop();
    const r = rig(root, {
      locks: async () => [{ path: join(root, 'dist'), reason: 'Deployed with the site.' }],
    });
    const { service } = await scanned(r);
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'dist' }],
      {},
    );
    expect(result.failed).toEqual([{ key: 'main:dist', error: 'Deployed with the site.' }]);
    expect(existsSync(join(root, 'dist'))).toBe(true);
  });

  it('refuses when it cannot tell which folders a deploy uses', async () => {
    const root = shop();
    const r = rig(root);
    const { service } = await scanned(r);
    r.deps.locks = async () => {
      throw new Error('deploy store is unreadable');
    };
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'dist' }],
      {},
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/deploy/i);
    expect(result.failed[0]?.error).not.toMatch(/unreadable/);
    expect(existsSync(join(root, 'dist'))).toBe(true);
  });

  it('refuses a location it does not know', async () => {
    const r = rig(shop());
    const { service } = await scanned(r);
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'nope', relPath: 'dist' }],
      {},
    );
    expect(result.failed).toHaveLength(1);
    expect(existsSync(join(r.root, 'dist'))).toBe(true);
  });

  it('refuses a folder that is no longer there, and says so plainly', async () => {
    const r = rig(shop());
    const { service } = await scanned(r);
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'node_modules/missing/dist' }],
      {},
    );
    expect(result.failed[0]?.error).toMatch(/not found|already gone|no longer/i);
  });

  it('refuses a link, since the link and not what it points at is all it could remove', async () => {
    const outside = writeTree(tempDir(), { 'precious.txt': 'keep' });
    const root = writeTree(tempDir(), { 'package.json': '{}' });
    try {
      symlinkSync(
        outside,
        join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    const r = rig(root);
    const result = await createProjectCleanup(r.deps).remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'node_modules' }],
      {},
    );
    expect(result.failed).toHaveLength(1);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });

  it('carries on with the rest when one folder cannot be deleted', async () => {
    const root = shop();
    const r = rig(root, {
      removeTree: async (path) => {
        if (path.endsWith('dist')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        const { rm } = await import('node:fs/promises');
        await rm(path, { recursive: true, force: true });
      },
    });
    const { service } = await scanned(r);
    const events: CleanupRemoveEvent[] = [];
    const result = await service.remove(
      'p1',
      [
        { kind: 'folder', locationId: 'main', relPath: 'dist' },
        { kind: 'folder', locationId: 'main', relPath: 'node_modules' },
      ],
      { requestId: 'r3', onEvent: (event) => events.push(event) },
    );
    expect(result.removed).toEqual(['main:node_modules']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.key).toBe('main:dist');
    expect(result.failed[0]?.error).toMatch(/using it/i);
    expect(result.failed[0]?.error).not.toMatch(/EBUSY/);
    expect(existsSync(join(root, 'dist'))).toBe(true);
    expect(events.filter((e) => e.status === 'failed')).toHaveLength(1);
  });

  it.each([
    ['EBUSY', /using it/i],
    ['EPERM', /using it|permission/i],
    ['EACCES', /permission/i],
    ['ENOSPC', /could not delete/i],
  ])('turns %s into a sentence', async (code, expected) => {
    const r = rig(shop(), {
      removeTree: async () => {
        throw Object.assign(new Error(`raw ${code} text`), { code });
      },
    });
    const { service } = await scanned(r);
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'dist' }],
      {},
    );
    expect(result.failed[0]?.error).toMatch(expected);
    expect(result.failed[0]?.error).not.toContain('raw');
    expect(result.failed[0]?.error).not.toContain('\u2014');
  });

  it('clears the Studio cache of the videos it is asked to and reports the freed bytes', async () => {
    const videos = [
      { videoId: 'v1', title: 'Launch', bytes: 900, busy: false },
      { videoId: 'v2', title: 'Teaser', bytes: 100, busy: false },
    ];
    const r = rig(shop(), {}, videos);
    const { service } = await scanned(r);
    const events: CleanupRemoveEvent[] = [];
    const result = await service.remove(
      'p1',
      [
        { kind: 'studio', videoId: 'v1' },
        { kind: 'studio', videoId: 'v2' },
      ],
      { requestId: 'r4', onEvent: (event) => events.push(event) },
    );
    expect(r.studio.cleared).toEqual([['v1', 'v2']]);
    expect(result).toEqual({ freedBytes: 1000, removed: ['studio:v1', 'studio:v2'], failed: [] });
    expect(events.filter((e) => e.status === 'done').map((e) => e.key)).toEqual([
      'studio:v1',
      'studio:v2',
    ]);
  });

  it('reports a video that is rendering as one it could not clear', async () => {
    const r = rig(shop(), {
      studio: {
        usage: async () => [{ videoId: 'v1', title: 'Launch', bytes: 900, busy: true }],
        clear: async () => ({
          freedBytes: 0,
          cleared: [],
          skipped: [{ videoId: 'v1', reason: 'busy' as const }],
        }),
      },
    });
    const { service } = await scanned(r);
    const result = await service.remove('p1', [{ kind: 'studio', videoId: 'v1' }], {});
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([
      { key: 'studio:v1', error: 'This video is rendering. Try again when the render is done.' },
    ]);
  });

  it('stops before the next item once cancelled', async () => {
    const r = rig(shop());
    const { service } = await scanned(r);
    const controller = new AbortController();
    const result = await service.remove(
      'p1',
      [
        { kind: 'folder', locationId: 'main', relPath: 'dist' },
        { kind: 'folder', locationId: 'main', relPath: 'node_modules' },
      ],
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.status === 'done') controller.abort();
        },
      },
    );
    expect(result.removed).toEqual(['main:dist']);
    expect(existsSync(join(r.root, 'node_modules'))).toBe(true);
  });

  it('refuses a project that is gone', async () => {
    const r = rig(shop());
    await expect(
      createProjectCleanup(r.deps).remove('ghost', [{ kind: 'studio', videoId: 'v1' }], {}),
    ).rejects.toThrow('That project no longer exists.');
  });

  it('does nothing for an empty request', async () => {
    const r = rig(shop());
    expect(await createProjectCleanup(r.deps).remove('p1', [], {})).toEqual({
      freedBytes: 0,
      removed: [],
      failed: [],
    });
  });

  it.runIf(hasGit())(
    'refuses a folder git tracks even though its name is on the list',
    async () => {
      const { dir } = initGitRepo({ 'package.json': '{}', 'build/keep.js': bytes(50) });
      const r = rig(dir);
      const result = await createProjectCleanup(r.deps).remove(
        'p1',
        [{ kind: 'folder', locationId: 'main', relPath: 'build' }],
        {},
      );
      expect(result.failed).toHaveLength(1);
      expect(existsSync(join(dir, 'build', 'keep.js'))).toBe(true);
    },
  );

  it.runIf(hasGit())('refuses a generic folder in a repository unless git ignores it', async () => {
    const { dir } = initGitRepo({ 'package.json': '{}' });
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'mine.txt'), 'mine');
    const r = rig(dir);
    const result = await createProjectCleanup(r.deps).remove(
      'p1',
      [{ kind: 'folder', locationId: 'main', relPath: 'out' }],
      {},
    );
    expect(result.failed).toHaveLength(1);
    expect(existsSync(join(dir, 'out', 'mine.txt'))).toBe(true);
  });

  it('deletes inside a worktree through its own location id', async () => {
    const root = writeTree(tempDir(), { 'package.json': '{}' });
    const wt = writeTree(tempDir(), { 'package.json': '{}', 'node_modules/x.js': bytes(77) });
    const r = rig(root, {
      worktrees: async () => [{ id: 'wt1', path: wt, branch: 'feat', missing: false }],
    });
    const service = createProjectCleanup(r.deps);
    await service.scan('p1', {});
    const result = await service.remove(
      'p1',
      [{ kind: 'folder', locationId: 'wt1', relPath: 'node_modules' }],
      {},
    );
    expect(result.removed).toEqual(['wt1:node_modules']);
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });
});
