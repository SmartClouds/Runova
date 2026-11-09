import { describe, expect, it } from 'vitest';
import { compareLoose, isBehind, isPrerelease, pickLatest, withPrecisionOf } from './versionText';

describe('isPrerelease', () => {
  it.each([
    '1.0.0-alpha01',
    '1.0.0-beta.2',
    '1.0.0-rc1',
    '2.0.0rc1',
    '2.0.0b3',
    '2.0.0.dev0',
    '3.0.0-M1',
    '3.0.0-SNAPSHOT',
  ])('treats %s as a pre-release', (version) => {
    expect(isPrerelease(version)).toBe(true);
  });

  it.each(['1.0.0', '33.0.0-jre', '33.0.0-android', '4.1.100.Final', '1.0.post1', '1.0.0+5'])(
    'treats %s as a release',
    (version) => {
      expect(isPrerelease(version)).toBe(false);
    },
  );
});

describe('compareLoose', () => {
  it('compares numerically, padding the shorter side', () => {
    expect(compareLoose('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareLoose('1.2', '1.2.0')).toBe(0);
  });

  it('sorts a pre-release before its release', () => {
    expect(compareLoose('1.0.0', '1.0.0-rc1')).toBeGreaterThan(0);
    expect(compareLoose('1.0.0-rc2', '1.0.0-rc10')).toBeLessThan(0);
  });

  it('ignores a leading v and build metadata', () => {
    expect(compareLoose('v1.2.3', '1.2.3+9')).toBe(0);
  });

  it('puts a post release after its release', () => {
    expect(compareLoose('1.0.post1', '1.0')).toBeGreaterThan(0);
  });
});

describe('pickLatest', () => {
  it('leaves pre-releases out for someone on a release', () => {
    expect(pickLatest(['1.0.0', '1.1.0', '2.0.0-beta1'], '1.0.0')).toBe('1.1.0');
  });

  it('offers pre-releases to someone already on one', () => {
    expect(pickLatest(['1.0.0-alpha01', '1.0.0-alpha02'], '1.0.0-alpha01')).toBe('1.0.0-alpha02');
  });

  it('keeps to the flavor in use, so guava -android never becomes -jre', () => {
    expect(pickLatest(['32.0.0-android', '33.0.0-jre', '33.0.0-android'], '32.0.0-android')).toBe(
      '33.0.0-android',
    );
    expect(pickLatest(['1.0.0', '2.0.0-jre'], '1.0.0')).toBe('1.0.0');
  });

  it('is null when nothing qualifies', () => {
    expect(pickLatest(['2.0.0-beta1'], '1.0.0')).toBeNull();
    expect(pickLatest([], '1.0.0')).toBeNull();
  });
});

describe('withPrecisionOf', () => {
  it('cuts the target to as many parts as the declared value has', () => {
    expect(withPrecisionOf('1.0.200', '1')).toBe('1');
    expect(withPrecisionOf('0.10.4', '0.9')).toBe('0.10');
    expect(withPrecisionOf('2.3.4', '1.2.3')).toBe('2.3.4');
  });

  it('keeps a pre-release suffix only at full precision', () => {
    expect(withPrecisionOf('2.0.0-rc1', '1.0.0')).toBe('2.0.0-rc1');
    expect(withPrecisionOf('2.0.0-rc1', '1')).toBe('2');
  });
});

describe('isBehind', () => {
  it('goes by the locked version when there is one', () => {
    expect(isBehind('1.0.100', '1', '1.0.200')).toBe(true);
    expect(isBehind('1.0.200', '1', '1.0.200')).toBe(false);
  });

  it('goes by what the declaration can express without a lock', () => {
    expect(isBehind(null, '1', '1.0.200')).toBe(false);
    expect(isBehind(null, '0.9', '0.10.1')).toBe(true);
    expect(isBehind(null, '1.2.3', '1.2.4')).toBe(true);
  });

  it('trusts a declaration that has moved past a stale lock', () => {
    expect(isBehind('5.6.4', '5.9', '5.9.1')).toBe(false);
  });

  it('is false with nothing to compare', () => {
    expect(isBehind(null, null, '1.0.0')).toBe(false);
  });

  it('never offers a downgrade', () => {
    expect(isBehind('2.0.0', '2.0', '1.9.9')).toBe(false);
  });
});
