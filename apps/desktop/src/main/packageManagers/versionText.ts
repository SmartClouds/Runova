/**
 * Version strings as PyPI, crates.io, Maven, git tags and CocoaPods write them. These are not all
 * semver (`2.0.0rc1`, `4.1.100.Final`, `33.0.0-jre`), so the numeric part is compared first and
 * whatever follows it is sorted by what kind of suffix it is.
 */

const PRERELEASE_SUFFIX =
  /^[-._]?(?:alpha|beta|rc|cr|dev|snapshot|preview|pre|eap|ea|milestone|nightly|canary|a|b|c|m)[-._]?\d*(?:[-._].*)?$/i;

interface Parts {
  core: number[];
  suffix: string;
}

function parts(version: string): Parts | null {
  const cleaned = version
    .trim()
    .replace(/^v(?=\d)/i, '')
    .replace(/\+.*$/, '');
  const match = /^(\d+(?:\.\d+)*)(.*)$/.exec(cleaned);
  return match ? { core: match[1].split('.').map(Number), suffix: match[2] } : null;
}

function suffixIsPrerelease(suffix: string): boolean {
  return suffix !== '' && PRERELEASE_SUFFIX.test(suffix);
}

export function isPrerelease(version: string): boolean {
  const parsed = parts(version);
  return parsed !== null && suffixIsPrerelease(parsed.suffix);
}

/** Below a plain release for a pre-release, above it for a qualifier like `.post1`. */
function suffixRank(suffix: string): number {
  if (suffix === '') return 0;
  return suffixIsPrerelease(suffix) ? -1 : 1;
}

/** Positive when `a` is newer than `b`. */
export function compareLoose(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return a.localeCompare(b, undefined, { numeric: true });
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  const rank = suffixRank(left.suffix) - suffixRank(right.suffix);
  if (rank !== 0) return rank;
  return left.suffix.localeCompare(right.suffix, undefined, { numeric: true });
}

/** The qualifier that makes a build a different product: `-android` is not `-jre`. */
function flavor(version: string): string {
  const parsed = parts(version);
  return parsed && !suffixIsPrerelease(parsed.suffix) ? parsed.suffix : '';
}

/**
 * The newest of a registry's versions someone on `current` would want: a release unless they are
 * already on a pre-release, and always of the same flavor.
 */
export function pickLatest(versions: string[], current: string): string | null {
  const allowPrerelease = isPrerelease(current);
  const wanted = flavor(current);
  let best: string | null = null;
  for (const version of versions) {
    if (!parts(version) || flavor(version) !== wanted) continue;
    if (isPrerelease(version) && !allowPrerelease) continue;
    if (best === null || compareLoose(version, best) > 0) best = version;
  }
  return best;
}

/** `target` written with as many parts as `declared` has, so `"1"` stays a one-part requirement. */
export function withPrecisionOf(target: string, declared: string): string {
  const parsedTarget = parts(target);
  const parsedDeclared = parts(declared);
  if (!parsedTarget || !parsedDeclared) return target;
  if (parsedDeclared.core.length >= parsedTarget.core.length) return target;
  return parsedTarget.core.slice(0, parsedDeclared.core.length).join('.');
}

/**
 * Whether `latest` is worth an update. With a lock, the question is whether the resolved version
 * is behind. Without one, or with a declaration that has moved past a stale lock, the question is
 * whether the declaration could say anything newer: `"1"` already allows every 1.x.
 */
export function isBehind(locked: string | null, declared: string | null, latest: string): boolean {
  if (locked && (!declared || compareLoose(locked, declared) >= 0)) {
    return compareLoose(latest, locked) > 0;
  }
  if (declared) return compareLoose(withPrecisionOf(latest, declared), declared) > 0;
  return false;
}
