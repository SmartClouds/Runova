import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { createCounters, measurePath } from './measure';

const bytes = (count: number): string => 'x'.repeat(count);

describe('measurePath', () => {
  it('measures a folder and keeps a running count of bytes and files', async () => {
    const root = writeTree(tempDir(), {
      'a.txt': bytes(10),
      'one/b.txt': bytes(100),
      'one/two/c.txt': bytes(1000),
    });
    const counters = createCounters();
    const size = await measurePath(root, { counters });
    expect(size).toMatchObject({ bytes: 1110, files: 3 });
    expect(counters).toEqual({ bytes: 1110, files: 3 });
  });

  it('adds to the same counters when several things are measured', async () => {
    const root = writeTree(tempDir(), { 'a/x.bin': bytes(7), 'b/y.bin': bytes(5) });
    const counters = createCounters();
    await measurePath(join(root, 'a'), { counters });
    await measurePath(join(root, 'b'), { counters });
    expect(counters).toEqual({ bytes: 12, files: 2 });
  });

  it('reports progress as it goes, never going backwards', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 120; index += 1) files[`d${index % 6}/f${index}.bin`] = bytes(10);
    const root = writeTree(tempDir(), files);
    const ticks: { bytes: number; files: number }[] = [];
    const counters = createCounters();
    await measurePath(root, {
      counters,
      progressEvery: 20,
      onTick: (tick) => ticks.push({ ...tick }),
    });
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < ticks.length; index += 1) {
      expect(ticks[index]?.bytes).toBeGreaterThanOrEqual(ticks[index - 1]?.bytes ?? 0);
      expect(ticks[index]?.files).toBeGreaterThanOrEqual(ticks[index - 1]?.files ?? 0);
    }
    expect(counters.files).toBe(120);
  });

  it('counts a folder that is not there as nothing', async () => {
    const counters = createCounters();
    const size = await measurePath(join(tempDir(), 'missing'), { counters });
    expect(size.bytes).toBe(0);
    expect(counters).toEqual({ bytes: 0, files: 0 });
  });

  it('stops when told to', async () => {
    const root = writeTree(tempDir(), { 'a/x.bin': bytes(5), 'b/y.bin': bytes(5) });
    const controller = new AbortController();
    controller.abort();
    await expect(
      measurePath(root, { counters: createCounters(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
