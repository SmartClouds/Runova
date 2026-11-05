import { linkSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CleanupCandidate } from '../../shared/projectCleanupTypes';
import { hasGit, initGitRepo, tempDir, writeTree } from '../../test/main/fixtures';
import { scanLocation } from './scan';

const bytes = (count: number): string => 'x'.repeat(count);

/** The size of every file under a folder, counted on its own so the scan has something to match. */
function treeBytes(dir: string): number {
  let sum = 0;
  for (const name of readdirSync(dir)) {
    const info = lstatSync(join(dir, name));
    if (info.isSymbolicLink()) continue;
    sum += info.isDirectory() ? treeBytes(join(dir, name)) : info.size;
  }
  return sum;
}

const relPaths = (candidates: readonly CleanupCandidate[]): string[] =>
  candidates.map((c) => c.relPath).sort();

function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

const canLink = ((): boolean => {
  try {
    linkDir(tempDir(), join(tempDir(), 'probe'));
    return true;
  } catch {
    return false;
  }
})();

/** A pnpm monorepo with no git, the shape most projects here have. */
function monorepo(): string {
  return writeTree(tempDir(), {
    'package.json': '{}',
    'pnpm-lock.yaml': bytes(30),
    'README.md': bytes(10),
    'node_modules/dep/index.js': bytes(1000),
    'apps/web/package.json': '{}',
    'apps/web/src/index.ts': bytes(40),
    'apps/web/node_modules/dep/index.js': bytes(2000),
    'apps/web/dist/main.js': bytes(300),
    'apps/web/.next/cache/x.bin': bytes(500),
    'packages/ui/package.json': '{}',
    'packages/ui/src/button.tsx': bytes(60),
    'packages/ui/build/out.js': bytes(70),
    'packages/ui/.turbo/log.txt': bytes(5),
  });
}

describe('scanLocation without git', () => {
  it('finds the folders a project can rebuild, at any depth', async () => {
    const root = monorepo();
    const result = await scanLocation({ locationId: 'main', root });
    expect(relPaths(result.candidates)).toEqual([
      'apps/web/.next',
      'apps/web/dist',
      'apps/web/node_modules',
      'node_modules',
      'packages/ui/.turbo',
      'packages/ui/build',
    ]);
  });

  it('measures each one and files it under its category', async () => {
    const root = monorepo();
    const { candidates } = await scanLocation({ locationId: 'main', root });
    const by = Object.fromEntries(candidates.map((c) => [c.relPath, c]));
    expect(by['node_modules']).toMatchObject({ bytes: 1000, files: 1, category: 'dependencies' });
    expect(by['apps/web/node_modules']).toMatchObject({ bytes: 2000, category: 'dependencies' });
    expect(by['apps/web/dist']).toMatchObject({ bytes: 300, category: 'build' });
    expect(by['apps/web/.next']).toMatchObject({ bytes: 500, category: 'build' });
    expect(by['packages/ui/.turbo']).toMatchObject({ bytes: 5, category: 'cache' });
  });

  it('carries the id, name and location the window needs to ask for it back', async () => {
    const root = monorepo();
    const { candidates } = await scanLocation({ locationId: 'wt-7', root });
    const dist = candidates.find((c) => c.relPath === 'apps/web/dist');
    expect(dist).toMatchObject({ id: 'wt-7:apps/web/dist', locationId: 'wt-7', name: 'dist' });
  });

  it('adds up to the whole folder, with the files it keeps counted too', async () => {
    const root = monorepo();
    const result = await scanLocation({ locationId: 'main', root });
    expect(result.totalBytes).toBe(treeBytes(root));
    const offered = result.candidates.reduce((sum, c) => sum + c.bytes, 0);
    expect(offered).toBe(1000 + 2000 + 300 + 500 + 70 + 5);
    expect(result.totalBytes).toBeGreaterThan(offered);
  });

  it('puts the biggest first', async () => {
    const root = monorepo();
    const { candidates } = await scanLocation({ locationId: 'main', root });
    const sizes = candidates.map((c) => c.bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('tells each node_modules to reinstall with the manager the workspace uses', async () => {
    const root = monorepo();
    const { candidates } = await scanLocation({ locationId: 'main', root });
    const nested = candidates.find((c) => c.relPath === 'apps/web/node_modules');
    expect(nested?.restore.command).toBe('pnpm install');
    expect(candidates.find((c) => c.relPath === 'node_modules')?.restore.command).toBe(
      'pnpm install',
    );
  });

  it('never offers what a person wrote or the tools keep for the project', async () => {
    const root = writeTree(tempDir(), {
      'package.json': '{}',
      'src/a.ts': bytes(10),
      'docs/readme.md': bytes(10),
      'public/logo.svg': bytes(10),
      '.env': 'SECRET=1',
      '.env.local': 'SECRET=2',
      '.runova/ROADMAP.md': bytes(10),
      '.claude/settings.json': '{}',
      '.vscode/settings.json': '{}',
    });
    const result = await scanLocation({ locationId: 'main', root });
    expect(result.candidates).toEqual([]);
    expect(result.totalBytes).toBe(treeBytes(root));
  });

  it('leaves a generic folder alone when no file beside it explains it', async () => {
    const root = writeTree(tempDir(), {
      'index.html': bytes(10),
      'dist/page.html': bytes(500),
      'build/notes.txt': bytes(500),
    });
    const result = await scanLocation({ locationId: 'main', root });
    expect(result.candidates).toEqual([]);
    expect(result.totalBytes).toBe(1010);
  });

  it('does not list what sits inside a folder it already offers', async () => {
    const root = writeTree(tempDir(), {
      'package.json': '{}',
      'node_modules/a/package.json': '{}',
      'node_modules/a/node_modules/b/index.js': bytes(100),
      'node_modules/a/dist/x.js': bytes(100),
      'node_modules/.cache/y.bin': bytes(100),
    });
    const { candidates } = await scanLocation({ locationId: 'main', root });
    expect(relPaths(candidates)).toEqual(['node_modules']);
    // The one package.json inside it, plus the three 100-byte files at different depths.
    expect(candidates[0]?.bytes).toBe(2 + 100 + 100 + 100);
  });

  it('offers a virtual environment only when pyvenv.cfg is inside', async () => {
    const root = writeTree(tempDir(), {
      '.venv/pyvenv.cfg': 'home = x',
      '.venv/lib/site.py': bytes(50),
      'venv/notes.txt': bytes(50),
    });
    const { candidates } = await scanLocation({ locationId: 'main', root });
    expect(relPaths(candidates)).toEqual(['.venv']);
  });

  it('leaves out names the caller excludes', async () => {
    const root = writeTree(tempDir(), {
      'composer.json': '{}',
      'vendor/autoload.php': bytes(20),
      'package.json': '{}',
      'node_modules/x.js': bytes(20),
    });
    const { candidates } = await scanLocation({
      locationId: 'main',
      root,
      excludeNames: new Set(['vendor']),
    });
    expect(relPaths(candidates)).toEqual(['node_modules']);
  });

  it('does not scan another location that sits inside this one', async () => {
    const root = writeTree(tempDir(), {
      'package.json': '{}',
      'node_modules/x.js': bytes(10),
      '.claude/worktrees/feature/package.json': '{}',
      '.claude/worktrees/feature/node_modules/big.js': bytes(9000),
    });
    const result = await scanLocation({
      locationId: 'main',
      root,
      skipRoots: [join(root, '.claude', 'worktrees', 'feature')],
    });
    expect(relPaths(result.candidates)).toEqual(['node_modules']);
    expect(result.totalBytes).toBe(2 + 10);
  });

  it('locks a folder a deploy site keeps in sync, but still lists it', async () => {
    const root = writeTree(tempDir(), {
      'package.json': '{}',
      'site/package.json': '{}',
      'site/dist/index.html': bytes(100),
      'node_modules/x.js': bytes(10),
    });
    const { candidates } = await scanLocation({
      locationId: 'main',
      root,
      locks: [{ path: join(root, 'site'), reason: 'Part of the deploy site "Marketing".' }],
    });
    const dist = candidates.find((c) => c.relPath === 'site/dist');
    expect(dist?.locked).toBe('Part of the deploy site "Marketing".');
    expect(candidates.find((c) => c.relPath === 'node_modules')?.locked).toBeNull();
  });

  it('locks a folder that contains a synced folder too', async () => {
    const root = writeTree(tempDir(), {
      'package.json': '{}',
      'dist/public/index.html': bytes(100),
    });
    const { candidates } = await scanLocation({
      locationId: 'main',
      root,
      locks: [{ path: join(root, 'dist', 'public'), reason: 'Deployed.' }],
    });
    expect(candidates.find((c) => c.relPath === 'dist')?.locked).toBe('Deployed.');
  });

  it('lets a lock name folders it does not cover, like a deploy that never ships node_modules', async () => {
    const root = writeTree(tempDir(), {
      'theme/package.json': '{}',
      'theme/node_modules/x.js': bytes(10),
      'theme/dist/app.js': bytes(10),
    });
    const { candidates } = await scanLocation({
      locationId: 'main',
      root,
      locks: [
        {
          path: join(root, 'theme'),
          reason: 'Deployed with the site.',
          exceptNames: new Set(['node_modules']),
        },
      ],
    });
    expect(candidates.find((c) => c.relPath === 'theme/node_modules')?.locked).toBeNull();
    expect(candidates.find((c) => c.relPath === 'theme/dist')?.locked).toBe(
      'Deployed with the site.',
    );
  });

  it('reports each folder as it is measured, and the same ones come back at the end', async () => {
    const root = monorepo();
    const seen: CleanupCandidate[] = [];
    const result = await scanLocation(
      { locationId: 'main', root },
      { onCandidate: (candidate) => seen.push(candidate) },
    );
    expect(relPaths(seen)).toEqual(relPaths(result.candidates));
  });

  it('reports how many files it has gone through', async () => {
    const files: Record<string, string> = { 'package.json': '{}' };
    for (let i = 0; i < 60; i += 1) files[`src/f${i}.ts`] = 'x';
    const root = writeTree(tempDir(), files);
    const counts: number[] = [];
    await scanLocation(
      { locationId: 'main', root },
      { onProgress: (seen) => counts.push(seen), progressEvery: 20 },
    );
    expect(counts.length).toBeGreaterThan(0);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('stops when told to', async () => {
    const root = monorepo();
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanLocation({ locationId: 'main', root }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('is empty for an empty folder', async () => {
    const result = await scanLocation({ locationId: 'main', root: tempDir() });
    expect(result).toMatchObject({ totalBytes: 0, gitBytes: 0, candidates: [] });
  });

  it.runIf(canLink)('does not follow a link out of the project', async () => {
    const outside = writeTree(tempDir(), {
      'package.json': '{}',
      'node_modules/huge.js': bytes(90_000),
    });
    const root = writeTree(tempDir(), { 'package.json': '{}', 'src/a.ts': bytes(5) });
    linkDir(outside, join(root, 'linked'));
    const result = await scanLocation({ locationId: 'main', root });
    expect(result.candidates).toEqual([]);
    expect(result.totalBytes).toBe(2 + 5);
  });

  it.runIf(canLink)('does not offer a link that is named like a dependency folder', async () => {
    const outside = writeTree(tempDir(), { 'big.js': bytes(90_000) });
    const root = writeTree(tempDir(), { 'package.json': '{}' });
    linkDir(outside, join(root, 'node_modules'));
    const result = await scanLocation({ locationId: 'main', root });
    expect(result.candidates).toEqual([]);
  });

  it('says how much of a folder is shared with something else', async () => {
    const store = writeTree(tempDir(), { 'pkg.js': bytes(400) });
    const root = writeTree(tempDir(), { 'package.json': '{}', 'node_modules/own.js': bytes(10) });
    try {
      linkSync(join(store, 'pkg.js'), join(root, 'node_modules', 'linked.js'));
    } catch {
      return;
    }
    const { candidates } = await scanLocation({ locationId: 'main', root });
    expect(candidates[0]).toMatchObject({ bytes: 410, sharedBytes: 400 });
  });

  it('finds nothing unreadable in an ordinary tree, empty folders and dotfiles included', async () => {
    const root = writeTree(tempDir(), { 'package.json': '{}', 'node_modules/a.js': bytes(10) });
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'empty', '.keep'), '');
    const result = await scanLocation({ locationId: 'main', root });
    expect(result.unreadable).toBe(0);
  });
});

describe.runIf(hasGit())('scanLocation in a git repository', () => {
  it('offers ignored folders and leaves out the ones git tracks', async () => {
    const { dir } = initGitRepo({
      '.gitignore': 'node_modules/\ndist/\n',
      'package.json': '{}',
      'build/keep.js': bytes(50),
      'src/a.ts': bytes(10),
    });
    writeTree(dir, { 'node_modules/x/i.js': bytes(100), 'dist/app.js': bytes(60) });
    const result = await scanLocation({ locationId: 'main', root: dir });
    expect(relPaths(result.candidates)).toEqual(['dist', 'node_modules']);
  });

  it('leaves out a generic folder that git neither tracks nor ignores', async () => {
    const { dir } = initGitRepo({ 'package.json': '{}' });
    writeTree(dir, { 'out/mine.txt': bytes(80), '.next/cache.bin': bytes(80) });
    const result = await scanLocation({ locationId: 'main', root: dir });
    // `out` is a name people use for their own folders, and nothing says this one is not.
    // `.next` is only ever a framework's output, so untracked is enough.
    expect(relPaths(result.candidates)).toEqual(['.next']);
  });

  it('measures the git history on its own and counts it in the total', async () => {
    const { dir } = initGitRepo({ 'package.json': '{}', 'src/a.ts': bytes(10) });
    const result = await scanLocation({ locationId: 'main', root: dir });
    expect(result.gitBytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBe(treeBytes(dir));
    expect(result.candidates.some((c) => c.relPath.startsWith('.git'))).toBe(false);
  });

  it('works when the project is a subfolder of the repository', async () => {
    const { dir } = initGitRepo({
      '.gitignore': 'dist/\n',
      'app/package.json': '{}',
      'app/build/keep.js': bytes(20),
    });
    writeTree(dir, { 'app/dist/main.js': bytes(30) });
    const result = await scanLocation({ locationId: 'main', root: join(dir, 'app') });
    expect(relPaths(result.candidates)).toEqual(['dist']);
  });
});
