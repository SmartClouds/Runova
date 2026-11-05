import { describe, expect, it } from 'vitest';
import { compareCacheVersions, isStableVersion, parseCacheVersion } from './versions.js';

describe('parseCacheVersion', () => {
  it.each([
    ['1.2.3', [1, 2, 3]],
    ['v1.2.3', [1, 2, 3]],
    ['V9.4.1', [9, 4, 1]],
    ['1.2.3.4', [1, 2, 3, 4]],
    ['1234', [1234]],
    ['24.15.0', [24, 15, 0]],
    ['  0.17.8  ', [0, 17, 8]],
  ])('reads %j as the numbers %j', (text, numbers) => {
    expect(parseCacheVersion(text)?.numbers).toEqual(numbers);
  });

  it('keeps the pre-release part apart from the numbers', () => {
    expect(parseCacheVersion('1.0.0-rc.1')).toMatchObject({ numbers: [1, 0, 0], pre: ['rc', 1] });
    expect(parseCacheVersion('10.0.0-preview.3.25171.5')?.pre).toEqual([
      'preview',
      3,
      25171,
      5,
    ]);
    expect(parseCacheVersion('8.5-rc-1')).toMatchObject({ numbers: [8, 5], pre: ['rc-1'] });
  });

  it('ignores build metadata, including the +incompatible mark Go puts on old major versions', () => {
    expect(parseCacheVersion('2.0.0+incompatible')).toMatchObject({ numbers: [2, 0, 0], pre: null });
    expect(parseCacheVersion('1.0.0+build.5')?.pre).toBeNull();
    expect(parseCacheVersion('1.0.0-beta.2+exp.sha.5114f85')?.pre).toEqual(['beta', 2]);
  });

  it.each([
    'LATEST',
    'r05',
    '',
    '   ',
    '1.2.x',
    'main',
    '2024-01-08T10:00',
    '.1.2',
    '1..2',
  ])('gives up on %j rather than guess an order', (text) => {
    expect(parseCacheVersion(text)).toBeNull();
  });
});

describe('isStableVersion', () => {
  it('is true for a release and false for anything with a pre-release part', () => {
    expect(isStableVersion('9.0.5')).toBe(true);
    expect(isStableVersion('v1.2.3+incompatible')).toBe(true);
    expect(isStableVersion('10.0.0-rc.1')).toBe(false);
    expect(isStableVersion('1.0.0-beta')).toBe(false);
  });

  it('is false for a version it cannot read', () => {
    expect(isStableVersion('LATEST')).toBe(false);
  });
});

describe('compareCacheVersions', () => {
  const sortedAscending = (versions: string[]): string[] =>
    [...versions].sort(compareCacheVersions);

  it('compares number by number, not as text', () => {
    expect(sortedAscending(['1.10.0', '1.9.0', '1.2.0'])).toEqual(['1.2.0', '1.9.0', '1.10.0']);
    expect(compareCacheVersions('10.0.0', '9.9.9')).toBeGreaterThan(0);
  });

  it('treats missing trailing parts as zero', () => {
    expect(compareCacheVersions('1.0', '1.0.0')).toBe(0);
    expect(compareCacheVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0);
  });

  it('puts a pre-release before the release it leads up to', () => {
    expect(compareCacheVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareCacheVersions('9.0.5', '10.0.0-rc.1')).toBeLessThan(0);
  });

  it('orders pre-releases the way semver says', () => {
    const expected = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    expect(sortedAscending([...expected].reverse())).toEqual(expected);
  });

  it('ignores build metadata', () => {
    expect(compareCacheVersions('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compareCacheVersions('2.0.0+incompatible', '2.0.0')).toBe(0);
  });

  it('orders browser revisions and the other plain numbers', () => {
    expect(sortedAscending(['1248', '1134', '1243'])).toEqual(['1134', '1243', '1248']);
  });

  it('sorts a version it cannot read below every version it can', () => {
    expect(compareCacheVersions('LATEST', '0.0.1')).toBeLessThan(0);
    expect(compareCacheVersions('0.0.1', 'LATEST')).toBeGreaterThan(0);
  });

  it('keeps two unreadable versions in a stable order by their text', () => {
    expect(compareCacheVersions('alpha', 'beta')).toBeLessThan(0);
    expect(compareCacheVersions('same', 'same')).toBe(0);
  });
});
