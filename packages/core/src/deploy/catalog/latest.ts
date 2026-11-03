import type { AnyCatalogTemplate, CatalogVersion, PinnedImage } from './types.js';
import { compareCatalogTags } from './updates.js';

/**
 * The newest releases of each catalog line, from what the app read off the registries. The
 * catalog's own pins (images.ts) are the floor and the fallback: with no registry data, or none
 * newer, a line is what was bundled.
 *
 * Which tags belong to a line:
 * - the same shape as the pin: the same leading `v`, as many numbers, and the same suffix, so
 *   `7.1.2-php8.3-apache` only ever moves to another `-php8.3-apache` build and a prerelease
 *   (`0.36.0-rc1`) or a floating tag (`0.38`, `latest`) never matches;
 * - the same leading numbers as the pin, as many as its `track` says: the major by default, so a
 *   major upgrade (PostgreSQL 18 to 19) stays a reviewed new line, and the minor for databases
 *   whose minors are lines of their own (MariaDB 11.4 LTS stays on 11.4.x);
 * - not one an older line of the same image claims, so the newest line never lists them twice.
 *
 * Each tag the app offers was checked by the main process to carry linux/amd64 and linux/arm64,
 * and an install still pins the digest it was checked with.
 */

export interface RegistryRelease {
  tag: string;
  digest: `sha256:${string}`;
}

export interface CatalogReleaseData {
  /** The day the registries were read, YYYY-MM-DD. Becomes resolvedAt of what they gave. */
  checkedAt: string;
  /** The checked releases of each repository, keyed like PinnedImage.repository. */
  repositories: Readonly<Record<string, readonly RegistryRelease[]>>;
}

export interface CatalogRelease {
  /** The main image's tag, which names the release in the version picker. */
  tag: string;
  version: CatalogVersion;
}

/** How many releases of a line the version picker offers. */
export const RELEASES_PER_LINE = 10;

interface ParsedTag {
  v: string;
  numbers: number[];
  suffix: string;
}

function parseTag(tag: string): ParsedTag | null {
  const match = /^(v?)(\d+(?:\.\d+)*)(.*)$/.exec(tag);
  if (!match) return null;
  return { v: match[1], numbers: match[2].split('.').map(Number), suffix: match[3] };
}

/** The number part of a tag, for labels: `v0.11.4` reads 0.11.4, `7.1.2-php8.3-apache` 7.1.2. */
export function catalogTagVersion(tag: string): string {
  const parsed = parseTag(tag);
  return parsed ? parsed.numbers.join('.') : tag;
}

/** A label pattern such as `Ollama {ollama} with Open WebUI {webui}`, filled from the images. */
export function fillVersionLabel(
  pattern: string,
  images: Readonly<Record<string, PinnedImage>>,
): string {
  return pattern.replace(/\{([A-Za-z0-9_-]+)\}/g, (_whole, role: string) => {
    const image = images[role];
    if (!image)
      throw new Error(
        `The label ${JSON.stringify(pattern)} names ${role}, which the version does not run.`,
      );
    return catalogTagVersion(image.tag);
  });
}

/** The tags of the pin's line, newest first. `prefix` is how many leading numbers must match. */
export function lineTags(pinned: string, tags: readonly string[], prefix: number = 1): string[] {
  const pin = parseTag(pinned);
  if (!pin) return [];
  const kept = new Set<string>();
  for (const tag of tags) {
    const parsed = parseTag(tag);
    if (!parsed || parsed.v !== pin.v || parsed.suffix !== pin.suffix) continue;
    if (parsed.numbers.length !== pin.numbers.length) continue;
    if (pin.numbers.slice(0, prefix).some((number, index) => parsed.numbers[index] !== number)) {
      continue;
    }
    kept.add(tag);
  }
  return [...kept].sort((a, b) => compareCatalogTags(b, a));
}

/** Every known release of an image's line: the registry's checked ones and the bundled pin. */
function knownReleases(
  pin: PinnedImage,
  data: CatalogReleaseData | null,
): Map<string, RegistryRelease> {
  const known = new Map<string, RegistryRelease>([[pin.tag, { tag: pin.tag, digest: pin.digest }]]);
  // The registry wins for the pin's own tag too: the same tag on another digest is a rebuild.
  for (const release of data?.repositories[pin.repository] ?? []) known.set(release.tag, release);
  return known;
}

function imageAt(
  pin: PinnedImage,
  release: RegistryRelease,
  checkedAt: string | undefined,
): PinnedImage {
  if (release.tag === pin.tag && release.digest === pin.digest) return pin;
  return {
    ...pin,
    tag: release.tag,
    digest: release.digest,
    resolvedAt: checkedAt ?? pin.resolvedAt,
  };
}

/** The newest release of a secondary image's line. */
function newestOf(pin: PinnedImage, data: CatalogReleaseData | null): PinnedImage {
  const known = knownReleases(pin, data);
  const [newest] = lineTags(pin.tag, [...known.keys()], pin.track);
  return imageAt(pin, known.get(newest ?? pin.tag) ?? pin, data?.checkedAt);
}

/** The releases of one line, newest first, at most RELEASES_PER_LINE. */
export function catalogReleases(
  template: AnyCatalogTemplate,
  versionId: string,
  data: CatalogReleaseData | null,
): CatalogRelease[] {
  const index = template.versions.findIndex((version) => version.id === versionId);
  if (index < 0) return [];
  const version = template.versions[index];
  const roles = Object.keys(version.images);
  if (roles.length === 0) return [];
  const [main, ...others] = roles;
  const pin = version.images[main];
  const known = knownReleases(pin, data);
  let tags = lineTags(pin.tag, [...known.keys()], pin.track);
  if (index === 0) {
    // What an older line of the same image claims is that line's, not this one's.
    const claimed = new Set<string>();
    for (const older of template.versions.slice(1)) {
      const olderPin = older.images[main];
      if (!olderPin || olderPin.repository !== pin.repository) continue;
      const olderKnown = knownReleases(olderPin, data);
      for (const tag of lineTags(olderPin.tag, [...olderKnown.keys()], olderPin.track)) {
        claimed.add(tag);
      }
    }
    tags = tags.filter((tag) => !claimed.has(tag));
  }
  const rest = Object.fromEntries(
    others.map((role) => [role, newestOf(version.images[role], data)]),
  );
  return tags.slice(0, RELEASES_PER_LINE).map((tag) => {
    const images: Record<string, PinnedImage> = {
      [main]: imageAt(pin, known.get(tag) ?? { tag: pin.tag, digest: pin.digest }, data?.checkedAt),
      ...rest,
    };
    const unchanged = roles.every((role) => images[role] === version.images[role]);
    if (unchanged) return { tag, version };
    return {
      tag,
      version: {
        ...version,
        images,
        label: version.labelPattern
          ? fillVersionLabel(version.labelPattern, images)
          : version.label,
      },
    };
  });
}

/** The newest release of a line, or the line as bundled. */
export function latestCatalogVersion(
  template: AnyCatalogTemplate,
  version: CatalogVersion,
  data: CatalogReleaseData | null,
): CatalogVersion {
  return catalogReleases(template, version.id, data)[0]?.version ?? version;
}

/** The template with every line on its newest release, for the update check and the store. */
export function withLatest<T extends AnyCatalogTemplate>(
  template: T,
  data: CatalogReleaseData | null,
): T {
  if (!data) return template;
  return {
    ...template,
    versions: template.versions.map((version) => latestCatalogVersion(template, version, data)),
  };
}

/** What an install or update asks for: the newest release of the line, or one it lists. */
export const LATEST_RELEASE = 'latest';

/**
 * The template with one line on the release picked from the version picker, ready to render.
 * Null when the line or the release is not listed, so a made-up tag never reaches a compose file.
 */
export function templateAtRelease<T extends AnyCatalogTemplate>(
  template: T,
  versionId: string,
  release: string,
  data: CatalogReleaseData | null,
): T | null {
  const releases = catalogReleases(template, versionId, data);
  const picked =
    release === LATEST_RELEASE ? releases[0] : releases.find((item) => item.tag === release);
  if (!picked) return null;
  return {
    ...template,
    versions: template.versions.map((version) =>
      version.id === versionId ? picked.version : version,
    ),
  };
}
