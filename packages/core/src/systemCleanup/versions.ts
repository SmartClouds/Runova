/**
 * Putting the versions a cache holds in order, so "keep the newest" keeps the right one.
 *
 * Caches name versions in many ways (`1.2.3`, `v0.17.8`, `10.0.0-rc.1`, `2.0.0+incompatible`, a
 * browser revision such as `1234`). This follows semantic versioning where it applies and extends
 * it to any number of dotted parts. A version it cannot read is reported as unreadable instead of
 * being given a guessed place, because a wrong guess here means deleting the newest copy.
 *
 * `devSetup/version.ts` is not used for this: it compares only the numeric prefix, so it reads
 * `1.2.3-rc.1` and `1.2.3` as the same version.
 */

export interface ParsedVersion {
  numbers: number[];
  /** The dot-separated pre-release part (`rc.1` becomes `['rc', 1]`), or null for a release. */
  pre: (string | number)[] | null;
}

const SHAPE = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseCacheVersion(text: string): ParsedVersion | null {
  const match = SHAPE.exec(text.trim().replace(/^v(?=\d)/i, ''));
  if (!match?.[1]) return null;
  const numbers = match[1].split('.').map((part) => Number.parseInt(part, 10));
  if (match[2] === undefined) return { numbers, pre: null };
  const identifiers = match[2].split('.');
  if (identifiers.some((identifier) => identifier === '')) return null;
  const pre = identifiers.map((identifier) =>
    /^\d+$/.test(identifier) ? Number.parseInt(identifier, 10) : identifier,
  );
  return { numbers, pre };
}

/** A release, as opposed to an alpha, beta or release candidate. False when it cannot be read. */
export function isStableVersion(text: string): boolean {
  const parsed = parseCacheVersion(text);
  return parsed !== null && parsed.pre === null;
}

function sign(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function compareText(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePre(a: (string | number)[], b: (string | number)[]): -1 | 0 | 1 {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const left = a[index] as string | number;
    const right = b[index] as string | number;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return sign(left - right);
    // A number is lower than text, as semver says.
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return compareText(left, right);
  }
  return sign(a.length - b.length);
}

/**
 * Negative when `a` is older than `b`, zero when they are the same version, positive when newer.
 * A version that cannot be read sorts below every one that can, and two of those by their text.
 */
export function compareCacheVersions(a: string, b: string): number {
  const left = parseCacheVersion(a);
  const right = parseCacheVersion(b);
  if (!left && !right) return compareText(a, b);
  if (!left) return -1;
  if (!right) return 1;

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return sign(difference);
  }
  if (!left.pre && !right.pre) return 0;
  // A release comes after the pre-releases that lead up to it.
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return comparePre(left.pre, right.pre);
}
