import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRASH_MARK } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { createDirReader } from './readDir';

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

describe('createDirReader', () => {
  it('lists the root for an empty path and a folder below it for a relative one', async () => {
    const root = writeTree(tempDir(), { 'a/one.txt': '1', 'a/b/two.txt': '2', 'top.txt': '3' });
    const read = createDirReader(root);
    const names = (entries: { name: string }[]): string[] => entries.map((e) => e.name).sort();
    expect(names(await read(''))).toEqual(['a', 'top.txt']);
    expect(names(await read('a'))).toEqual(['b', 'one.txt']);
    expect(names(await read('a/b'))).toEqual(['two.txt']);
  });

  it('says which entries are folders', async () => {
    const root = writeTree(tempDir(), { 'dir/x.txt': 'x', 'file.txt': 'f' });
    const entries = await createDirReader(root)('');
    expect(entries.find((e) => e.name === 'dir')?.isDirectory).toBe(true);
    expect(entries.find((e) => e.name === 'file.txt')?.isDirectory).toBe(false);
  });

  it('lists a folder that is not there, or is a file, as empty', async () => {
    const root = writeTree(tempDir(), { 'file.txt': 'f' });
    const read = createDirReader(root);
    expect(await read('missing')).toEqual([]);
    expect(await read('file.txt')).toEqual([]);
  });

  it.skipIf(!canLink)(
    'does not call a linked folder a folder, so nothing walks through it',
    async () => {
      const root = tempDir();
      const outside = writeTree(tempDir(), { 'secret.txt': 's' });
      mkdirSync(join(root, 'real'));
      linkDir(outside, join(root, 'link'));
      const entries = await createDirReader(root)('');
      expect(entries.find((e) => e.name === 'real')?.isDirectory).toBe(true);
      expect(entries.find((e) => e.name === 'link')?.isDirectory).toBe(false);
    },
  );

  it('rethrows an error that is not about the folder being missing', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'f'), 'x');
    const read = createDirReader(root, {
      readdir: async () => {
        throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
      },
    });
    await expect(read('')).rejects.toThrow('disk on fire');
  });

  it('skips a folder it may not read, tells the caller, and carries on', async () => {
    const root = tempDir();
    const skipped: string[] = [];
    const read = createDirReader(
      root,
      {
        readdir: async () => {
          throw Object.assign(new Error('nope'), { code: 'EACCES' });
        },
      },
      (path) => skipped.push(path),
    );
    expect(await read('locked')).toEqual([]);
    expect(skipped).toEqual(['locked']);
  });

  it('reports a folder an earlier clean-up set aside, with its path from the cache root', async () => {
    const root = writeTree(tempDir(), {
      [`pkg/1.0.0${TRASH_MARK}abc/old.bin`]: 'x',
      'pkg/2.0.0/new.bin': 'y',
      [`top${TRASH_MARK}def/z.bin`]: 'z',
    });
    const found: string[] = [];
    const read = createDirReader(root, undefined, undefined, (path) => found.push(path));
    await read('');
    await read('pkg');
    expect(found.sort()).toEqual([`pkg/1.0.0${TRASH_MARK}abc`, `top${TRASH_MARK}def`]);
  });
});
