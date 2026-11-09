import {
  ANDROID_REPOSITORY_MANIFEST_URL,
  compareVersions,
  type DevArch,
  type DevOs,
  flutterManifestUrl,
  pickFlutterRelease,
} from '@runova/core';

/**
 * Where the newest version of each runtime comes from. Every feed is a small public JSON file,
 * asked at most once per half hour: a scan of a large monorepo would otherwise ask the same
 * question once per sub-project. A feed that cannot be reached answers null, which the Packages
 * tab shows as "Latest unknown", and it is tried again a minute later.
 */

const FEED_TIMEOUT_MS = 15000;
const FRESH_MS = 30 * 60_000;
const RETRY_MS = 60_000;

const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const DOTNET_INDEX_URL =
  'https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json';
const DART_STABLE_URL =
  'https://storage.googleapis.com/dart-archive/channels/stable/release/latest/VERSION';
const PYTHON_RELEASES_URL = 'https://endoflife.date/api/python.json';
const RUST_RELEASES_URL = 'https://endoflife.date/api/rust.json';
const GRADLE_CURRENT_URL = 'https://services.gradle.org/versions/current';
const SWIFT_RELEASES_URL = 'https://www.swift.org/api/v1/install/releases.json';

const SEMVER = /^\d+\.\d+\.\d+$/;
const RELEASE = /^\d+(?:\.\d+){1,2}$/;

export interface DotnetChannel {
  /** The channel as a target framework names it, e.g. `10.0`. */
  channel: string;
  /** The newest SDK of that channel, e.g. `10.0.100`. */
  latestSdk: string;
}

export interface FlutterStable {
  version: string;
  /** The Dart SDK that ships inside it. */
  dartVersion: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The newest LTS release. The index is sorted newest first, and `lts` is false or a codename. */
export function parseNodeIndex(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    if (!isRecord(entry) || !entry.lts || typeof entry.version !== 'string') continue;
    const version = entry.version.replace(/^v/, '');
    if (SEMVER.test(version)) return version;
  }
  return null;
}

/**
 * The newest channel that is generally available. Previews and release candidates show up in the
 * index as `preview` or `go-live`, and a project should not be moved onto those by a button.
 */
export function parseDotnetIndex(data: unknown): DotnetChannel | null {
  if (!isRecord(data) || !Array.isArray(data['releases-index'])) return null;
  let best: { major: number; minor: number; channel: DotnetChannel } | null = null;
  for (const entry of data['releases-index']) {
    if (!isRecord(entry) || entry['support-phase'] !== 'active') continue;
    const channel = entry['channel-version'];
    const latestSdk = entry['latest-sdk'];
    if (typeof channel !== 'string' || typeof latestSdk !== 'string') continue;
    const match = /^(\d+)\.(\d+)$/.exec(channel);
    if (!match || !SEMVER.test(latestSdk)) continue;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (!best || major > best.major || (major === best.major && minor > best.minor)) {
      best = { major, minor, channel: { channel, latestSdk } };
    }
  }
  return best?.channel ?? null;
}

/** The Dart stable channel's VERSION file, `{"version": "3.13.5", ...}`. */
export function parseDartVersion(data: unknown): string | null {
  if (!isRecord(data) || typeof data.version !== 'string') return null;
  return SEMVER.test(data.version) ? data.version : null;
}

function newest(versions: unknown[]): string | null {
  const releases = versions.filter(
    (version): version is string => typeof version === 'string' && RELEASE.test(version),
  );
  return releases.sort(compareVersions).at(-1) ?? null;
}

/** An endoflife.date product list: one entry per release line, each with its `latest`. */
export function parseEndOfLife(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  return newest(data.map((entry) => (isRecord(entry) ? entry.latest : null)));
}

/** Gradle's `versions/current`. Only a final release counts. */
export function parseGradleCurrent(data: unknown): string | null {
  if (!isRecord(data) || data.snapshot === true || data.nightly === true) return null;
  return newest([data.version]);
}

/** swift.org's release list, oldest first. */
export function parseSwiftReleases(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  return newest(data.map((entry) => (isRecord(entry) ? entry.name : null)));
}

/** The newest API level with a platform on Google's stable channel. */
export function parseAndroidApi(xml: string): string | null {
  let best: number | null = null;
  for (const match of xml.matchAll(
    /<remotePackage path="platforms;android-(\d+)(?:\.\d+)?">[\s\S]*?<channelRef ref="channel-(\d+)"\/>/g,
  )) {
    if (match[2] !== '0') continue;
    const level = Number(match[1]);
    if (best === null || level > best) best = level;
  }
  return best === null ? null : String(best);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/** The `latest` dist-tag of an npm package, or null when the registry cannot be reached. */
export async function fetchLatestFromRegistry(
  name: string,
  timeoutMs = FEED_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Remembers each answer, a failed one (null) for less time. Concurrent askers share one request. */
function remembered<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < FRESH_MS) return hit.value as Promise<T | null>;
  const value = load().catch(() => null);
  cache.set(key, { at: now, value });
  void value.then((result) => {
    if (result === null) cache.set(key, { at: now - FRESH_MS + RETRY_MS, value });
  });
  return value;
}

/** For tests: forget every remembered answer. */
export function clearRuntimeFeedCache(): void {
  cache.clear();
}

function currentOs(): DevOs {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

function currentArch(): DevArch {
  return process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'other';
}

export const runtimeFeeds = {
  nodeLts: () => remembered('node', async () => parseNodeIndex(await fetchJson(NODE_INDEX_URL))),
  /** Bun, pnpm and npm all publish themselves to the npm registry. */
  npmPackage: (name: string) => remembered(`npm:${name}`, () => fetchLatestFromRegistry(name)),
  dotnet: () =>
    remembered('dotnet', async () => parseDotnetIndex(await fetchJson(DOTNET_INDEX_URL))),
  dart: () => remembered('dart', async () => parseDartVersion(await fetchJson(DART_STABLE_URL))),
  python: () =>
    remembered('python', async () => parseEndOfLife(await fetchJson(PYTHON_RELEASES_URL))),
  rust: () => remembered('rust', async () => parseEndOfLife(await fetchJson(RUST_RELEASES_URL))),
  gradle: () =>
    remembered('gradle', async () => parseGradleCurrent(await fetchJson(GRADLE_CURRENT_URL))),
  swift: () =>
    remembered('swift', async () => parseSwiftReleases(await fetchJson(SWIFT_RELEASES_URL))),
  androidApi: () =>
    remembered('android', async () => {
      const res = await fetch(ANDROID_REPOSITORY_MANIFEST_URL, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Android repository returned ${res.status}`);
      return parseAndroidApi(await res.text());
    }),
  flutter: () =>
    remembered<FlutterStable>('flutter', async () => {
      const os = currentOs();
      // The version is the same for every CPU, so an unusual one still gets an answer.
      const arch = currentArch() === 'arm64' && os === 'darwin' ? 'arm64' : 'x64';
      const release = pickFlutterRelease(await fetchJson(flutterManifestUrl(os)), os, arch);
      return release ? { version: release.version, dartVersion: release.dartVersion } : null;
    }),
};
