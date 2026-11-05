import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, lstat, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TRASH_MARK } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { type RemoveFs, removeItem } from './removeTree';

const realFs: RemoveFs = {
  lstat,
  realpath,
  rename,
  readdir: (path) => readdir(path, { withFileTypes: true }),
  unlink,
  rmdir,
  chmod,
};

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

const allow = (): null => null;
const noWait = async (): Promise<void> => undefined;
const options = { guard: allow, sleep: noWait };

function errorWith(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('removeItem', () => {
  it('removes a folder and everything in it', async () => {
    const root = writeTree(tempDir(), {
      'pkg/1.0.0/lib/a.dll': 'a',
      'pkg/1.0.0/lib/deep/b.dll': 'b',
      'pkg/1.0.0/readme.md': 'r',
      'pkg/2.0.0/keep.txt': 'k',
    });
    const outcome = await removeItem(join(root, 'pkg', '1.0.0'), options);
    expect(outcome.status).toBe('removed');
    expect(existsSync(join(root, 'pkg', '1.0.0'))).toBe(false);
    expect(existsSync(join(root, 'pkg', '2.0.0', 'keep.txt'))).toBe(true);
  });

  it('leaves nothing behind under the name it set it aside with', async () => {
    const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
    await removeItem(join(root, 'pkg', '1.0.0'), options);
    expect(readdirSync(join(root, 'pkg'))).toEqual([]);
  });

  it('removes a single file', async () => {
    const root = writeTree(tempDir(), { 'rand-0.8.5.crate': 'crate', 'other.crate': 'x' });
    expect((await removeItem(join(root, 'rand-0.8.5.crate'), options)).status).toBe('removed');
    expect(existsSync(join(root, 'rand-0.8.5.crate'))).toBe(false);
    expect(existsSync(join(root, 'other.crate'))).toBe(true);
  });

  it('says it is gone when there is nothing there', async () => {
    const outcome = await removeItem(join(tempDir(), 'missing'), options);
    expect(outcome).toEqual({ status: 'gone' });
  });

  it('renames before it deletes, so a tool never sees a half-removed folder', async () => {
    const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
    const renames: [string, string][] = [];
    await removeItem(join(root, 'pkg', '1.0.0'), {
      ...options,
      fs: {
        ...realFs,
        rename: async (from, to) => {
          renames.push([from, to]);
          await rename(from, to);
        },
      },
    });
    expect(renames).toHaveLength(1);
    const [from, to] = renames[0] ?? ['', ''];
    expect(from).toBe(join(root, 'pkg', '1.0.0'));
    expect(dirname(to)).toBe(dirname(from));
    expect(basename(to).startsWith(`1.0.0${TRASH_MARK}`)).toBe(true);
    expect(basename(to).length).toBeGreaterThan(`1.0.0${TRASH_MARK}`.length);
  });

  describe('the guard', () => {
    it('refuses, and removes nothing, when the guard says no', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        guard: () => 'Not inside the cache.',
      });
      expect(outcome).toEqual({ status: 'refused', reason: 'Not inside the cache.' });
      expect(existsSync(join(root, 'pkg', '1.0.0', 'a.bin'))).toBe(true);
    });

    it('is asked about the real path, not the one it was given', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const seen: string[] = [];
      await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        guard: (path) => {
          seen.push(path);
          return null;
        },
      });
      expect(seen).toEqual([join(await realpath(root), 'pkg', '1.0.0')]);
    });
  });

  describe.skipIf(!canLink)('links', () => {
    it('removes a link itself and never what it points at', async () => {
      const root = tempDir();
      const outside = writeTree(tempDir(), { 'precious.txt': 'keep me' });
      linkDir(outside, join(root, 'link'));
      const outcome = await removeItem(join(root, 'link'), options);
      expect(outcome.status).toBe('removed');
      expect(existsSync(join(root, 'link'))).toBe(false);
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    });

    it('removes a link inside the folder without following it', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const outside = writeTree(tempDir(), { 'precious.txt': 'keep me' });
      linkDir(outside, join(root, 'pkg', '1.0.0', 'shortcut'));
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), options);
      expect(outcome.status).toBe('removed');
      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
    });
  });

  describe('files that resist', () => {
    it('removes a read-only file', async () => {
      const root = writeTree(tempDir(), {
        'pkg/1.0.0/locked.bin': 'x',
        'pkg/1.0.0/free.bin': 'y',
      });
      chmodSync(join(root, 'pkg', '1.0.0', 'locked.bin'), 0o444);
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), options);
      expect(outcome.status).toBe('removed');
      expect(existsSync(join(root, 'pkg', '1.0.0'))).toBe(false);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'removes a folder that has been made read-only, as Go does to its module cache',
      async () => {
        const root = writeTree(tempDir(), { 'mod@v1.0.0/sub/a.go': 'a', 'mod@v1.0.0/b.go': 'b' });
        chmodSync(join(root, 'mod@v1.0.0', 'sub'), 0o555);
        chmodSync(join(root, 'mod@v1.0.0'), 0o555);
        const outcome = await removeItem(join(root, 'mod@v1.0.0'), options);
        expect(outcome.status).toBe('removed');
        expect(existsSync(join(root, 'mod@v1.0.0'))).toBe(false);
      },
    );

    it('tries again when something is briefly using a file', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      let failures = 0;
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        fs: {
          ...realFs,
          unlink: async (path) => {
            if (failures < 2) {
              failures += 1;
              throw errorWith('EBUSY');
            }
            await unlink(path);
          },
        },
      });
      expect(failures).toBe(2);
      expect(outcome.status).toBe('removed');
    });

    it('gives up on a file that stays in use, and says so', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        fs: {
          ...realFs,
          unlink: async () => {
            throw errorWith('EBUSY');
          },
        },
      });
      expect(outcome.status).toBe('failed');
      expect(outcome.status === 'failed' && outcome.reason).toMatch(/in use/i);
    });

    it('ignores a file that vanished while it was working', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a', 'pkg/1.0.0/b.bin': 'b' });
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        fs: {
          ...realFs,
          unlink: async (path) => {
            await unlink(path);
            if (basename(path) === 'a.bin') throw errorWith('ENOENT');
          },
        },
      });
      expect(outcome.status).toBe('removed');
    });
  });

  describe('when it cannot be set aside', () => {
    it('reports it as in use and touches nothing', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        fs: {
          ...realFs,
          rename: async () => {
            throw errorWith('EBUSY');
          },
        },
      });
      expect(outcome.status).toBe('in-use');
      expect(existsSync(join(root, 'pkg', '1.0.0', 'a.bin'))).toBe(true);
    });

    it('reports a refusal by the system the same way', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        fs: {
          ...realFs,
          rename: async () => {
            throw errorWith('EPERM');
          },
        },
      });
      expect(outcome.status).toBe('in-use');
    });

    it('reports anything else as a failure and touches nothing', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        fs: {
          ...realFs,
          rename: async () => {
            throw errorWith('EIO');
          },
        },
      });
      expect(outcome.status).toBe('failed');
      expect(existsSync(join(root, 'pkg', '1.0.0', 'a.bin'))).toBe(true);
    });
  });

  describe('cancelling', () => {
    it('stops part way, and what is left is under the name that marks it for deletion', async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < 40; index += 1) {
        files[`pkg/1.0.0/d${index % 4}/f${index}.bin`] = 'x';
      }
      const root = writeTree(tempDir(), files);
      const controller = new AbortController();
      let removed = 0;
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        signal: controller.signal,
        fs: {
          ...realFs,
          unlink: async (path) => {
            await unlink(path);
            removed += 1;
            if (removed === 5) controller.abort();
          },
        },
      });
      expect(outcome.status).toBe('cancelled');
      expect(removed).toBeLessThan(40);
      const left = readdirSync(join(root, 'pkg'));
      expect(left).toHaveLength(1);
      expect(left[0]).toContain(TRASH_MARK);
    });

    it('does nothing at all if it was cancelled before it began', async () => {
      const root = writeTree(tempDir(), { 'pkg/1.0.0/a.bin': 'a' });
      const controller = new AbortController();
      controller.abort();
      const outcome = await removeItem(join(root, 'pkg', '1.0.0'), {
        ...options,
        signal: controller.signal,
      });
      expect(outcome.status).toBe('cancelled');
      expect(existsSync(join(root, 'pkg', '1.0.0', 'a.bin'))).toBe(true);
    });
  });

  it('finishes a folder an earlier run set aside, without setting it aside again', async () => {
    const root = tempDir();
    const leftover = join(root, `1.0.0${TRASH_MARK}abc123`);
    mkdirSync(leftover);
    writeFileSync(join(leftover, 'a.bin'), 'a');
    const renames: string[] = [];
    const outcome = await removeItem(leftover, {
      ...options,
      fs: {
        ...realFs,
        rename: async (from, to) => {
          renames.push(from);
          await rename(from, to);
        },
      },
    });
    expect(outcome.status).toBe('removed');
    expect(renames).toEqual([]);
    expect(existsSync(leftover)).toBe(false);
  });
});
