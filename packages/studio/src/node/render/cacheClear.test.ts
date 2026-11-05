import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { CLEARABLE_CACHE, clearVideoCache, videoCacheBytes } from './cacheClear.js';

const tempDir = useTempDirs();

async function put(root: string, path: string, bytes: number): Promise<void> {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes));
}

/** A video's cache the way the app leaves it: all four kinds of cache side by side. */
async function fullCache(): Promise<string> {
  const dir = join(await tempDir(), 'video-1');
  await put(dir, 'scenes/abc/chunk-0000.mkv', 1000);
  await put(dir, 'scenes/abc/inputs.json', 20);
  await put(dir, 'scenes/def/chunk-0000.mkv', 500);
  await put(dir, 'media/hash1/proxy.mp4', 300);
  await put(dir, 'media/hash1/poster.jpg', 30);
  await put(dir, 'voice/recordings/take-1.wav', 7000);
  await put(dir, 'voice/narration/line.wav', 4000);
  await put(dir, 'gen/job1/image.png', 9000);
  return dir;
}

async function canLink(): Promise<boolean> {
  const dir = await tempDir();
  try {
    await symlink(
      dir,
      join(await tempDir(), 'probe'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return true;
  } catch {
    return false;
  }
}

describe('CLEARABLE_CACHE', () => {
  it('lists only the caches that can be made again from the video itself', () => {
    expect([...CLEARABLE_CACHE].sort()).toEqual(['media', 'scenes']);
  });
});

describe('videoCacheBytes', () => {
  it('counts the scene chunks and the media previews, and nothing else', async () => {
    const dir = await fullCache();
    expect(await videoCacheBytes(dir)).toBe(1000 + 20 + 500 + 300 + 30);
  });

  it('is zero when the video has no cache yet', async () => {
    expect(await videoCacheBytes(join(await tempDir(), 'nothing'))).toBe(0);
  });

  it('is zero when the cache holds only things that are never cleared', async () => {
    const dir = join(await tempDir(), 'video-2');
    await put(dir, 'voice/recordings/take.wav', 5000);
    await put(dir, 'gen/j/x.png', 5000);
    expect(await videoCacheBytes(dir)).toBe(0);
  });
});

describe('clearVideoCache', () => {
  it('removes the scene chunks and media previews and says how much that freed', async () => {
    const dir = await fullCache();
    const freed = await clearVideoCache(dir);
    expect(freed).toBe(1850);
    expect((await readdir(dir)).sort()).toEqual(['gen', 'voice']);
  });

  it('leaves the recordings, the narration and the generated media exactly as they were', async () => {
    const dir = await fullCache();
    await clearVideoCache(dir);
    expect((await readFile(join(dir, 'voice/recordings/take-1.wav'))).length).toBe(7000);
    expect((await readFile(join(dir, 'voice/narration/line.wav'))).length).toBe(4000);
    expect((await readFile(join(dir, 'gen/job1/image.png'))).length).toBe(9000);
  });

  it('is a no-op for a video with no cache', async () => {
    expect(await clearVideoCache(join(await tempDir(), 'nothing'))).toBe(0);
  });

  it('can be run twice', async () => {
    const dir = await fullCache();
    await clearVideoCache(dir);
    expect(await clearVideoCache(dir)).toBe(0);
  });

  it('removes a link inside the cache without touching what it points at', async () => {
    if (!(await canLink())) return;
    const outside = await tempDir();
    await put(outside, 'precious.txt', 123);
    const dir = await fullCache();
    await symlink(
      outside,
      join(dir, 'scenes', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await clearVideoCache(dir);
    expect((await readFile(join(outside, 'precious.txt'))).length).toBe(123);
  });
});
