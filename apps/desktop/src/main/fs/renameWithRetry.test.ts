import { describe, expect, it, vi } from 'vitest';
import { renameWithRetry } from './renameWithRetry';

describe('renameWithRetry', () => {
  // A virus scanner or the search indexer can hold a freshly unpacked folder for a moment on
  // Windows, and the move then fails with a permission or busy error that goes away by itself.
  const problem = (code: string) =>
    Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  const mover = () => vi.fn<(from: string, to: string) => Promise<void>>(async () => undefined);
  const noWait = () => vi.fn(async (_ms: number) => undefined);

  it('moves straight away when nothing is in the way', async () => {
    const rename = mover();
    const wait = noWait();

    await renameWithRetry('from', 'to', { rename, wait });

    expect(rename).toHaveBeenCalledExactlyOnceWith('from', 'to');
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EBUSY'])('tries again after %s and succeeds', async (code) => {
    const rename = mover();
    rename.mockRejectedValueOnce(problem(code)).mockRejectedValueOnce(problem(code));
    const wait = noWait();

    await expect(renameWithRetry('from', 'to', { rename, wait })).resolves.toBeUndefined();

    expect(rename).toHaveBeenCalledTimes(3);
    expect(rename).toHaveBeenLastCalledWith('from', 'to');
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('waits a little longer after each failed try', async () => {
    const rename = mover();
    rename
      .mockRejectedValueOnce(problem('EPERM'))
      .mockRejectedValueOnce(problem('EPERM'))
      .mockRejectedValueOnce(problem('EBUSY'));
    const wait = noWait();

    await renameWithRetry('from', 'to', { rename, wait });

    const delays = wait.mock.calls.map(([ms]) => ms);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays[2]).toBeGreaterThan(delays[1] ?? 0);
  });

  it('gives up after a few tries and throws the last problem', async () => {
    const rename = mover();
    rename.mockRejectedValue(problem('EPERM'));
    const wait = noWait();

    await expect(renameWithRetry('from', 'to', { rename, wait })).rejects.toThrow('EPERM');

    expect(rename.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(rename.mock.calls.length).toBeLessThanOrEqual(8);
    expect(wait).toHaveBeenCalledTimes(rename.mock.calls.length - 1);
  });

  it('does not retry a problem that waiting would not fix', async () => {
    const rename = mover();
    rename.mockRejectedValue(problem('ENOENT'));
    const wait = noWait();

    await expect(renameWithRetry('from', 'to', { rename, wait })).rejects.toThrow('ENOENT');

    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
