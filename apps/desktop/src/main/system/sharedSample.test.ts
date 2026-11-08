import { describe, expect, it, vi } from 'vitest';
import { sharedSample } from './sharedSample';

describe('sharedSample', () => {
  it('gives two readers close together the same reading', async () => {
    let now = 1000;
    const read = vi.fn(async () => now);
    const shared = sharedSample(read, 2000, () => now);

    const first = await shared();
    now += 1500;
    const second = await shared();

    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('takes a new reading once the last one is old enough', async () => {
    let now = 1000;
    const read = vi.fn(async () => now);
    const shared = sharedSample(read, 2000, () => now);

    await shared();
    now += 2000;

    await expect(shared()).resolves.toBe(3000);
  });

  it('shares a reading that is still being taken', async () => {
    let finish: (value: number) => void = () => undefined;
    const read = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)));
    const shared = sharedSample(read, 2000, () => 0);

    const both = Promise.all([shared(), shared()]);
    finish(7);

    await expect(both).resolves.toEqual([7, 7]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed reading', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValueOnce(5);
    const shared = sharedSample(read, 2000, () => 0);

    await expect(shared()).rejects.toThrow('no');
    await expect(shared()).resolves.toBe(5);
  });
});
