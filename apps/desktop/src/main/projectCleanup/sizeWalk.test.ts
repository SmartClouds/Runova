import { linkSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { type MeasureFs, measureTree } from './sizeWalk';

/** A file of exactly `bytes` bytes. */
const bytes = (count: number): string => 'x'.repeat(count);

/** Links a folder. Windows needs a junction, which any user can create. */
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

const canHardLink = ((): boolean => {
  try {
    const dir = tempDir();
    writeFileSync(join(dir, 'a'), 'a');
    linkSync(join(dir, 'a'), join(dir, 'b'));
    return true;
  } catch {
    return false;
  }
})();

describe('measureTree', () => {
  it('adds up every file in a nested tree and counts them', async () => {
    const root = writeTree(tempDir(), {
      'a.txt': bytes(10),
      'one/b.txt': bytes(100),
      'one/two/c.txt': bytes(1000),
      'one/two/three/d.txt': bytes(10000),
      'other/e.txt': bytes(5),
    });
    const size = await measureTree(root);
    expect(size.bytes).toBe(11115);
    expect(size.files).toBe(5);
  });

  it('is zero for an empty folder', async () => {
    const size = await measureTree(tempDir());
    expect(size).toMatchObject({ bytes: 0, files: 0, sharedBytes: 0 });
  });

  it('is zero for a folder that is not there', async () => {
    const size = await measureTree(join(tempDir(), 'missing'));
    expect(size).toMatchObject({ bytes: 0, files: 0 });
  });

  it('measures a lone file as itself', async () => {
    const root = writeTree(tempDir(), { 'only.bin': bytes(42) });
    const size = await measureTree(join(root, 'only.bin'));
    expect(size).toMatchObject({ bytes: 42, files: 1 });
  });

  it('reports the newest modification time under the folder', async () => {
    const root = writeTree(tempDir(), { 'old.txt': 'a', 'deep/new.txt': 'b' });
    utimesSync(join(root, 'old.txt'), 1_000, 1_000);
    utimesSync(join(root, 'deep', 'new.txt'), 5_000, 5_000);
    const size = await measureTree(root);
    expect(size.newestMs).toBe(5_000_000);
  });

  it.runIf(canLink)('does not follow a link out of the folder', async () => {
    const outside = writeTree(tempDir(), { 'huge.bin': bytes(50_000) });
    const root = writeTree(tempDir(), { 'inside.txt': bytes(7) });
    linkDir(outside, join(root, 'escape'));
    const size = await measureTree(root);
    expect(size.bytes).toBe(7);
  });

  it.runIf(canLink)('does not loop on a link back to a parent', async () => {
    const root = writeTree(tempDir(), { 'sub/file.txt': bytes(3) });
    linkDir(root, join(root, 'sub', 'back'));
    const size = await measureTree(root);
    expect(size.bytes).toBe(3);
  });

  it.runIf(canHardLink)(
    'counts files that are hard linked elsewhere as shared, which deleting does not free',
    async () => {
      const store = writeTree(tempDir(), { 'pkg.js': bytes(500) });
      const tree = writeTree(tempDir(), { 'own.js': bytes(20) });
      linkSync(join(store, 'pkg.js'), join(tree, 'linked.js'));
      const size = await measureTree(tree);
      expect(size.bytes).toBe(520);
      expect(size.sharedBytes).toBe(500);
    },
  );

  it('keeps going when a file disappears between listing and reading it', async () => {
    const root = writeTree(tempDir(), { 'keep.txt': bytes(8), 'gone.txt': bytes(99) });
    const real = realFs();
    const fs: MeasureFs = {
      readdir: real.readdir,
      lstat: async (path) => {
        if (path.endsWith('gone.txt')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return real.lstat(path);
      },
    };
    const size = await measureTree(root, { fs });
    expect(size.bytes).toBe(8);
  });

  it('skips a folder it may not read and says how many it skipped', async () => {
    const root = writeTree(tempDir(), { 'ok/a.txt': bytes(4), 'locked/b.txt': bytes(900) });
    const real = realFs();
    const fs: MeasureFs = {
      lstat: real.lstat,
      readdir: async (path) => {
        if (path.endsWith('locked')) throw Object.assign(new Error('no'), { code: 'EACCES' });
        return real.readdir(path);
      },
    };
    const size = await measureTree(root, { fs });
    expect(size.bytes).toBe(4);
    expect(size.unreadable).toBe(1);
  });

  it('rejects with an AbortError once the signal fires, instead of finishing the walk', async () => {
    const root = writeTree(tempDir(), { 'a/1.txt': 'a', 'a/2.txt': 'b', 'b/3.txt': 'c' });
    const controller = new AbortController();
    const real = realFs();
    const fs: MeasureFs = {
      lstat: real.lstat,
      readdir: async (path) => {
        controller.abort();
        return real.readdir(path);
      },
    };
    await expect(measureTree(root, { fs, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects at once when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(measureTree(tempDir(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('never has more reads in flight than the limit allows', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) files[`d${i % 6}/f${i}.txt`] = 'x';
    const root = writeTree(tempDir(), files);
    const real = realFs();
    let active = 0;
    let peak = 0;
    const track = async <T>(work: () => Promise<T>): Promise<T> => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await work();
      } finally {
        active -= 1;
      }
    };
    const fs: MeasureFs = {
      lstat: (path) => track(() => real.lstat(path)),
      readdir: (path) => track(() => real.readdir(path)),
    };
    const size = await measureTree(root, { fs, concurrency: 4 });
    expect(size.files).toBe(60);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('reports the files it has seen so far while it works', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) files[`d/f${i}.txt`] = 'x';
    const root = writeTree(tempDir(), files);
    const seen: number[] = [];
    await measureTree(root, { onFiles: (count) => seen.push(count), progressEvery: 10 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBeLessThanOrEqual(30);
  });

  it('measures a deep tree without running out of stack', async () => {
    const base = tempDir();
    const deepest = join(base, ...Array.from({ length: 80 }, () => 'd'));
    mkdirSync(deepest, { recursive: true });
    writeFileSync(join(deepest, 'leaf.txt'), 'leaf');
    const size = await measureTree(base);
    expect(size.bytes).toBe(4);
  });
});

/** The real filesystem, shaped like the walker's injectable one. */
function realFs(): MeasureFs {
  return {
    readdir: async (path) => {
      const { readdir } = await import('node:fs/promises');
      return readdir(path, { withFileTypes: true });
    },
    lstat: async (path) => {
      const { lstat } = await import('node:fs/promises');
      return lstat(path);
    },
  };
}
