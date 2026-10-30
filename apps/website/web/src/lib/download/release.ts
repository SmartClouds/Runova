import { version as desktopVersion } from '../../../../../desktop/package.json';

/**
 * The latest desktop release, read from the website API (`GET /api/v1/releases/latest`, T010) and
 * kept in memory for 5 minutes. When the API is down the last release read keeps being served; when
 * there never was one, the page falls back to BUILD_VERSION and GITHUB_RELEASES_URL.
 */

export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export const ARCHES = ['x64', 'arm64', 'universal'] as const;
export const KINDS = ['nsis', 'dmg', 'zip', 'appimage', 'deb'] as const;

export type ReleasePlatform = (typeof PLATFORMS)[number];
export type ReleaseArch = (typeof ARCHES)[number];
export type ReleaseKind = (typeof KINDS)[number];

/** A `ReleaseAssetDto` from the API contract. */
export interface ReleaseAsset {
  name: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  kind: ReleaseKind;
  size: number;
  sha256: string | null;
  downloadUrl: string;
}

/** A `ReleaseDto` from the API contract. */
export interface Release {
  version: string;
  tagName: string;
  name: string;
  publishedAt: string;
  notesUrl: string;
  fetchedAt: string;
  assets: ReleaseAsset[];
}

/** The desktop app's version when the site was built, shown when no release could be read. */
export const BUILD_VERSION: string = desktopVersion;

export const GITHUB_RELEASES_URL = 'https://github.com/SmartClouds/Runova/releases/latest';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isHttpsUrl = (value: unknown): value is string => {
  if (!isString(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.includes(value as T);
}

function parseAsset(value: unknown): ReleaseAsset | null {
  if (!isObject(value)) return null;
  const { name, platform, arch, kind, size, sha256, downloadUrl } = value;
  if (
    !isString(name) ||
    !oneOf(PLATFORMS, platform) ||
    !oneOf(ARCHES, arch) ||
    !oneOf(KINDS, kind) ||
    typeof size !== 'number' ||
    !(sha256 === null || isString(sha256)) ||
    !isHttpsUrl(downloadUrl)
  ) {
    return null;
  }
  return { name, platform, arch, kind, size, sha256, downloadUrl };
}

/** A ReleaseDto checked field by field. Assets the page cannot show are dropped. */
export function parseRelease(value: unknown): Release | null {
  if (!isObject(value)) return null;
  const { version, tagName, name, publishedAt, notesUrl, fetchedAt, assets } = value;
  if (
    !isString(version) ||
    !isString(tagName) ||
    !isString(name) ||
    !isString(publishedAt) ||
    !isHttpsUrl(notesUrl) ||
    !isString(fetchedAt) ||
    !Array.isArray(assets)
  ) {
    return null;
  }
  const parsed = assets.map(parseAsset).filter((asset) => asset !== null);
  return { version, tagName, name, publishedAt, notesUrl, fetchedAt, assets: parsed };
}

export interface ReleaseSourceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a release is used before the API is asked again. */
  ttlMs?: number;
  /** How long to wait before asking an API that just failed. */
  retryMs?: number;
  timeoutMs?: number;
}

interface CacheEntry {
  release: Release | null;
  etag: string | null;
  /** Until when the entry is used as it is. */
  freshUntil: number;
}

export interface ReleaseSource {
  /** The latest release, or null when the API never gave one. */
  latest(apiUrl: string | undefined): Promise<Release | null>;
}

export function createReleaseSource(options: ReleaseSourceOptions = {}): ReleaseSource {
  const {
    fetch: fetchFn = globalThis.fetch,
    now = Date.now,
    ttlMs = 5 * 60_000,
    retryMs = 30_000,
    timeoutMs = 2_000,
  } = options;
  const cache = new Map<string, CacheEntry>();
  // Requests that arrive while the API is being asked wait for that one answer.
  const pending = new Map<string, Promise<CacheEntry>>();

  async function refresh(apiUrl: string, entry: CacheEntry | undefined): Promise<CacheEntry> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (entry?.release && entry.etag) headers['if-none-match'] = entry.etag;
    try {
      const response = await fetchFn(`${apiUrl.replace(/\/+$/, '')}/api/v1/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 304 && entry?.release) {
        return { ...entry, freshUntil: now() + ttlMs };
      }
      if (response.ok) {
        const release = parseRelease(await response.json());
        if (release) {
          return { release, etag: response.headers.get('etag'), freshUntil: now() + ttlMs };
        }
      }
    } catch {
      // Down, slow or not JSON: handled below like any other failure.
    }
    return {
      release: entry?.release ?? null,
      etag: entry?.etag ?? null,
      freshUntil: now() + retryMs,
    };
  }

  return {
    async latest(apiUrl) {
      if (!apiUrl) return null;
      const entry = cache.get(apiUrl);
      if (entry && now() < entry.freshUntil) return entry.release;
      let request = pending.get(apiUrl);
      if (!request) {
        request = refresh(apiUrl, entry).then((next) => {
          cache.set(apiUrl, next);
          pending.delete(apiUrl);
          return next;
        });
        pending.set(apiUrl, request);
      }
      return (await request).release;
    },
  };
}

/** The server's one source, shared by every request. */
export const releaseSource = createReleaseSource();
