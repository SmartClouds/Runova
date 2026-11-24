import { describe, expect, it } from 'vitest';
import { createCloneProgressParser, parseByteSize } from './cloneProgress';

/** What `git clone --progress` printed for a small GitHub repo, CR updates and all. */
const REAL_CLONE =
  "Cloning into '.'...\n" +
  'remote: Enumerating objects: 1000, done.\n' +
  'remote: Counting objects:   1% (1/100)\rremote: Counting objects:  50% (50/100)\rremote: Counting objects: 100% (100/100), done.\n' +
  'remote: Compressing objects:  40% (4/10)\rremote: Compressing objects: 100% (10/10), done.\n' +
  'remote: Total 1000 (delta 5), reused 990 (delta 2), pack-reused 0\n' +
  'Receiving objects:   0% (1/1000)\rReceiving objects:  58% (580/1000), 12.40 MiB | 2.10 MiB/s\rReceiving objects: 100% (1000/1000), 20.00 MiB | 3.00 MiB/s, done.\n' +
  'Resolving deltas:   0% (0/10)\rResolving deltas:  30% (3/10)\rResolving deltas: 100% (10/10), done.\n' +
  'Updating files:  50% (5/10)\rUpdating files: 100% (10/10), done.\n';

describe('parseByteSize', () => {
  it('reads the sizes git prints', () => {
    expect(parseByteSize('512 bytes')).toBe(512);
    expect(parseByteSize('1.50 KiB')).toBe(1536);
    expect(parseByteSize('12.40 MiB')).toBe(Math.round(12.4 * 1024 * 1024));
    expect(parseByteSize('1.00 GiB')).toBe(1024 ** 3);
    expect(parseByteSize('nonsense')).toBeUndefined();
  });
});

describe('createCloneProgressParser', () => {
  it('reports each phase of a real clone in order and ends at 100', () => {
    const parser = createCloneProgressParser();
    const seen = [];
    for (const char of REAL_CLONE) {
      const update = parser.push(char);
      if (update) seen.push(update);
    }
    const phases = [...new Set(seen.map((update) => update.phase))];
    expect(phases).toEqual(['remote', 'receiving', 'resolving', 'checkout']);
    expect(seen.at(-1)?.percent).toBe(100);
  });

  it('never moves backwards, even when a later phase starts at 0%', () => {
    const parser = createCloneProgressParser();
    const percents: number[] = [];
    for (const chunk of REAL_CLONE.split(/(?<=\r|\n)/)) {
      const update = parser.push(chunk);
      if (update) percents.push(update.percent);
    }
    expect(percents.length).toBeGreaterThan(5);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1] as number);
    }
  });

  it('maps receiving into the middle of the bar and keeps size and speed', () => {
    const parser = createCloneProgressParser();
    const update = parser.push('Receiving objects:  50% (500/1000), 12.40 MiB | 2.10 MiB/s\r');
    expect(update).toEqual({
      phase: 'receiving',
      percent: 43,
      receivedBytes: Math.round(12.4 * 1024 * 1024),
      bytesPerSecond: Math.round(2.1 * 1024 * 1024),
    });
  });

  it('waits for the end of a line split across chunks', () => {
    const parser = createCloneProgressParser();
    expect(parser.push('Resolving del')).toBeNull();
    expect(parser.push('tas:  50% (5/10)')).toBeNull();
    expect(parser.push('\r')).toMatchObject({ phase: 'resolving', percent: 84 });
  });

  it('turns a line without a percent into a phase change only', () => {
    const parser = createCloneProgressParser();
    expect(parser.push('remote: Enumerating objects: 1000, done.\n')).toEqual({
      phase: 'remote',
      percent: 0,
    });
  });

  it('ignores banners, totals and lines it does not know', () => {
    const parser = createCloneProgressParser();
    expect(parser.push("Cloning into '.'...\n")).toBeNull();
    expect(parser.push('remote: Total 3 (delta 0), reused 0 (delta 0)\n')).toBeNull();
    expect(parser.push('warning: redirecting to https://github.com/a/b.git/\n')).toBeNull();
  });

  it('accepts the older "Checking out files" wording and CRLF endings', () => {
    const parser = createCloneProgressParser();
    expect(parser.push('Checking out files: 100% (3/3), done.\r\n')).toEqual({
      phase: 'checkout',
      percent: 100,
    });
  });

  it('returns nothing when a line repeats the same progress', () => {
    const parser = createCloneProgressParser();
    expect(parser.push('Resolving deltas:  30% (3/10)\r')).not.toBeNull();
    expect(parser.push('Resolving deltas:  30% (3/10)\r')).toBeNull();
  });
});
