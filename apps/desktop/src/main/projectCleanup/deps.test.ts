import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjects: vi.fn(),
  listProjectWorktrees: vi.fn(),
  readFileSites: vi.fn(),
  cacheUsage: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock('../store', () => ({ store: { getProjects: mocks.getProjects } }));
vi.mock('../worktrees/service', () => ({ listProjectWorktrees: mocks.listProjectWorktrees }));
vi.mock('../deploy/files/store', () => ({ readFileSites: mocks.readFileSites }));
vi.mock('../studio', () => ({
  studioService: () => ({ cacheUsage: mocks.cacheUsage, clearCache: mocks.clearCache }),
}));

import { createCleanupDeps } from './deps';

const ROOT = join('C:', 'work', 'shop');

function project(over: Record<string, unknown> = {}) {
  return { id: 'p1', name: 'Shop', folderPath: ROOT, ...over };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProjects.mockResolvedValue([project(), project({ id: 'p2', name: 'Other' })]);
  mocks.listProjectWorktrees.mockResolvedValue([]);
  mocks.readFileSites.mockResolvedValue([]);
});

describe('getProject', () => {
  it('finds a project by id and hands over only what clean-up needs', async () => {
    expect(await createCleanupDeps().getProject('p1')).toEqual({
      id: 'p1',
      name: 'Shop',
      folderPath: ROOT,
    });
  });

  it('is null for a project that is not there', async () => {
    expect(await createCleanupDeps().getProject('nope')).toBeNull();
  });
});

describe('worktrees', () => {
  it('lists the worktrees with just their id, folder, branch and whether they are gone', async () => {
    mocks.listProjectWorktrees.mockResolvedValue([
      { id: 'w1', path: 'D:/wt/a', branch: 'feat', missing: false, status: {}, locked: false },
      { id: 'w2', path: 'D:/wt/b', branch: null, missing: true, status: null, locked: false },
    ]);
    expect(await createCleanupDeps().worktrees('p1')).toEqual([
      { id: 'w1', path: 'D:/wt/a', branch: 'feat', missing: false },
      { id: 'w2', path: 'D:/wt/b', branch: null, missing: true },
    ]);
    expect(mocks.listProjectWorktrees).toHaveBeenCalledWith('p1');
  });
});

describe('locks', () => {
  it('has none for a project no deploy touches', async () => {
    expect(await createCleanupDeps().locks('p1', ROOT)).toEqual([]);
  });

  it('locks the local folder of every deploy site attached to the project, and only those', async () => {
    mocks.readFileSites.mockResolvedValue([
      { id: 's1', label: 'Marketing', localFolder: join(ROOT, 'site'), projectIds: ['p1'] },
      { id: 's2', label: 'Elsewhere', localFolder: join('D:', 'other'), projectIds: ['p2'] },
      { id: 's3', label: 'Shared', localFolder: join(ROOT, 'docs'), projectIds: ['p1', 'p2'] },
    ]);
    const locks = await createCleanupDeps().locks('p1', ROOT);
    expect(locks.map((l) => l.path)).toEqual([join(ROOT, 'site'), join(ROOT, 'docs')]);
    expect(locks[0]?.reason).toBe('Kept in step with the deploy site "Marketing".');
  });

  it('locks the folder of every WordPress item the project deploys, except what a deploy never ships', async () => {
    mocks.getProjects.mockResolvedValue([
      project({
        wordpress: {
          siteId: 's',
          linkedAt: 'x',
          items: [
            { kind: 'theme', slug: 'twentytwentyfive' },
            { kind: 'plugin', slug: 'shop-core' },
          ],
        },
      }),
    ]);
    const locks = await createCleanupDeps().locks('p1', ROOT);
    expect(locks.map((l) => l.path)).toEqual([
      join(ROOT, 'wp-content', 'themes', 'twentytwentyfive'),
      join(ROOT, 'wp-content', 'plugins', 'shop-core'),
    ]);
    expect(locks[0]?.reason).toMatch(/WordPress/);
    // A deploy leaves these out, so they stay free to delete.
    expect(locks[0]?.exceptNames?.has('node_modules')).toBe(true);
    // And these it ships.
    expect(locks[0]?.exceptNames?.has('dist')).toBe(false);
    expect(locks[0]?.exceptNames?.has('vendor')).toBe(false);
  });

  it('puts the WordPress items under the checkout it is asked about', async () => {
    mocks.getProjects.mockResolvedValue([
      project({
        wordpress: {
          siteId: 's',
          linkedAt: 'x',
          items: [{ kind: 'mu-plugin', slug: 'loader.php' }],
        },
      }),
    ]);
    const worktree = join('D:', 'wt', 'feat');
    const locks = await createCleanupDeps().locks('p1', worktree);
    expect(locks[0]?.path).toBe(join(worktree, 'wp-content', 'mu-plugins', 'loader.php'));
  });

  it('has none for a project that is gone', async () => {
    expect(await createCleanupDeps().locks('nope', ROOT)).toEqual([]);
  });

  it('lets a failure to read the deploy sites through, so the service can lock everything', async () => {
    mocks.readFileSites.mockRejectedValue(new Error('corrupt'));
    await expect(createCleanupDeps().locks('p1', ROOT)).rejects.toThrow('corrupt');
  });
});

describe('studio', () => {
  it('returns the videos with something to clear', async () => {
    const videos = [{ videoId: 'v1', title: 'Launch', bytes: 5, busy: false }];
    mocks.cacheUsage.mockResolvedValue({ videos });
    expect(await createCleanupDeps().studio.usage('p1')).toEqual(videos);
    expect(mocks.cacheUsage).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('clears by video id', async () => {
    const outcome = { freedBytes: 9, cleared: ['v1'], skipped: [] };
    mocks.clearCache.mockResolvedValue(outcome);
    expect(await createCleanupDeps().studio.clear(['v1'])).toEqual(outcome);
    expect(mocks.clearCache).toHaveBeenCalledWith({ videoIds: ['v1'] });
  });
});
