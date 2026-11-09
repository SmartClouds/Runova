export type ReleaseChannel = 'stable' | 'beta' | 'preview';

/**
 * `version` on `channel`: the plain number for a stable release, else the next free
 * pre-release of it (`1.3.0-beta.1`, then `-beta.2` once that one is tagged). Only the
 * tags in hand are counted, and git still turns down a duplicate this misses.
 */
export function versionOnChannel(
  version: string,
  channel: ReleaseChannel,
  prefix: string,
  existingTags: readonly string[],
): string {
  if (channel === 'stable') return version;
  const stem = `${prefix}${version}-${channel}.`;
  let highest = 0;
  for (const existing of existingTags) {
    if (!existing.startsWith(stem)) continue;
    const n = Number(existing.slice(stem.length));
    if (Number.isInteger(n) && n > highest) highest = n;
  }
  return `${version}-${channel}.${highest + 1}`;
}
