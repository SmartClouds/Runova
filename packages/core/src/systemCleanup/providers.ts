import {
  decodeGoPath,
  isBunScopeDir,
  isGradleVersionDir,
  splitBunEntry,
  splitDashVersion,
  splitElectronArtifact,
  splitGoVersionDir,
  splitGradleDist,
  splitRevisionEntry,
} from './layouts.js';
import type {
  CacheProvider,
  CacheProviderId,
  DirEntryInfo,
  DirReader,
  EnumeratedItem,
} from './types.js';
import { parseCacheVersion } from './versions.js';

/**
 * The caches Disk Cleanup knows about, one entry each. Adding a tool is one entry here plus a test
 * of how it lays its folders out: finding the cache, listing what is in it and what its own
 * cleaning command is all live in the entry, so nothing else needs to learn about it.
 *
 * Two kinds. A `versioned` cache keeps a folder per version, so old versions can be removed one by
 * one. An `opaque` cache (npm, pnpm, pip, Go's build cache) is a content-addressed store whose
 * files only its own tool understands, so Disk Cleanup measures it and only ever cleans it by
 * running that tool's command, never by deleting inside it.
 *
 * Tools that start a daemon or fetch things when run (Gradle, Maven, Flutter, Dart) are never run
 * to find a path. They are found by their environment variable or their usual folder.
 */

/** Left in a folder name by the app itself while it deletes, so no listing should count it. */
export const TRASH_MARK = '.runova-trash-';

/** The group for entries that have no version, such as a manifest. They are kept when pruning. */
export const OTHER_GROUP = 'other';
const OTHER_LABEL = 'Other files';

const LIST_PARALLELISM = 16;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

function join(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('/');
}

/** Everything in a cache that is not a version of something, kept as one entry. */
class Others {
  private readonly paths: string[] = [];

  add(path: string): void {
    this.paths.push(path);
  }

  toItem(): EnumeratedItem[] {
    if (this.paths.length === 0) return [];
    return [{ group: OTHER_GROUP, groupLabel: OTHER_LABEL, version: null, paths: this.paths }];
  }
}

function dirsOf(entries: DirEntryInfo[]): DirEntryInfo[] {
  return entries.filter((entry) => entry.isDirectory);
}

// --- Finding a cache -----------------------------------------------------------------------

/** The last line of a tool's answer that is an absolute path. */
export function lastAbsolutePathLine(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (/^[A-Za-z]:[\\/]/.test(line) || line.startsWith('\\\\') || line.startsWith('/'))
      return line;
  }
  return null;
}

/** The path after `label:` in a line such as `http-cache: C:\Users\me\v3-cache`. */
function labelledPath(label: string): (output: string) => string | null {
  const pattern = new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, 'gm');
  return (output) => {
    let found: string | null = null;
    for (const match of output.matchAll(pattern)) found = match[1] ?? found;
    return found;
  };
}

// --- Reading what a cache holds ------------------------------------------------------------

async function enumerateNuget(read: DirReader): Promise<EnumeratedItem[]> {
  const others = new Others();
  const packages: DirEntryInfo[] = [];
  for (const entry of await read('')) {
    // `.tools` and friends are not packages; a stray file is not either.
    if (entry.isDirectory && !entry.name.startsWith('.')) packages.push(entry);
    else others.add(entry.name);
  }
  const listed = await mapLimited(packages, LIST_PARALLELISM, async (pkg) => ({
    pkg,
    versions: dirsOf(await read(pkg.name)),
  }));
  const items: EnumeratedItem[] = [];
  for (const { pkg, versions } of listed) {
    for (const version of versions) {
      items.push({
        group: pkg.name.toLowerCase(),
        groupLabel: pkg.name,
        version: version.name,
        paths: [join(pkg.name, version.name)],
      });
    }
  }
  return [...items, ...others.toItem()];
}

const NUGET_PACKAGE_FILE = /\.nupkg(?:\.metadata|\.sha512)?$/i;
const NUGET_SAMPLE = 5;

/** A real NuGet version folder holds the package or the files NuGet writes beside it. */
async function nugetLooksRight(read: DirReader, items: EnumeratedItem[]): Promise<boolean> {
  const versions = items.filter((item) => item.version !== null).slice(0, NUGET_SAMPLE);
  if (versions.length === 0) return true;
  for (const item of versions) {
    const entries = await read(item.paths[0] ?? '');
    if (entries.some((entry) => !entry.isDirectory && NUGET_PACKAGE_FILE.test(entry.name))) {
      return true;
    }
  }
  return false;
}

async function enumerateBun(read: DirReader): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];
  const others = new Others();
  const scopes: string[] = [];
  for (const entry of await read('')) {
    const parsed = entry.isDirectory ? splitBunEntry(entry.name) : null;
    if (parsed) {
      items.push({
        group: parsed.name,
        groupLabel: parsed.name,
        version: parsed.version,
        paths: [entry.name],
      });
    } else if (entry.isDirectory && isBunScopeDir(entry.name)) {
      scopes.push(entry.name);
    } else {
      others.add(entry.name);
    }
  }
  const listed = await mapLimited(scopes, LIST_PARALLELISM, async (scope) => ({
    scope,
    entries: await read(scope),
  }));
  for (const { scope, entries } of listed) {
    for (const entry of entries) {
      const parsed = entry.isDirectory ? splitBunEntry(entry.name) : null;
      if (!parsed) {
        others.add(join(scope, entry.name));
        continue;
      }
      const name = `${scope}/${parsed.name}`;
      items.push({
        group: name,
        groupLabel: name,
        version: parsed.version,
        paths: [join(scope, entry.name)],
      });
    }
  }
  return [...items, ...others.toItem()];
}

async function enumerateCargo(read: DirReader): Promise<EnumeratedItem[]> {
  const byVersion = new Map<string, EnumeratedItem>();
  const others = new Others();

  const add = (index: string, base: string, path: string): void => {
    const parsed = splitDashVersion(base);
    if (!parsed) {
      others.add(path);
      return;
    }
    const key = `${index}/${parsed.name}@${parsed.version}`;
    const existing = byVersion.get(key);
    if (existing) existing.paths.push(path);
    else {
      byVersion.set(key, {
        group: `${index}/${parsed.name}`,
        groupLabel: parsed.name,
        version: parsed.version,
        paths: [path],
      });
    }
  };

  for (const area of ['cache', 'src'] as const) {
    for (const index of dirsOf(await read(area))) {
      for (const entry of await read(join(area, index.name))) {
        const path = join(area, index.name, entry.name);
        if (area === 'cache' && !entry.isDirectory && entry.name.endsWith('.crate')) {
          add(index.name, entry.name.slice(0, -'.crate'.length), path);
        } else if (area === 'src' && entry.isDirectory) {
          add(index.name, entry.name, path);
        } else {
          others.add(path);
        }
      }
    }
  }
  // The registry index is what Cargo checks versions against; it is rebuilt on demand.
  for (const entry of await read('')) {
    if (entry.name !== 'cache' && entry.name !== 'src') others.add(entry.name);
  }
  return [...byVersion.values(), ...others.toItem()];
}

async function enumeratePub(read: DirReader): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];
  const others = new Others();
  const hosts: string[] = [];
  for (const entry of await read('')) {
    if (entry.isDirectory) hosts.push(entry.name);
    else others.add(entry.name);
  }
  const listed = await mapLimited(hosts, LIST_PARALLELISM, async (host) => ({
    host,
    entries: await read(host),
  }));
  for (const { host, entries } of listed) {
    for (const entry of entries) {
      const parsed = entry.isDirectory ? splitDashVersion(entry.name) : null;
      if (!parsed) {
        others.add(join(host, entry.name));
        continue;
      }
      items.push({
        group: `${host}/${parsed.name}`,
        groupLabel: host === 'pub.dev' ? parsed.name : `${parsed.name} (${host})`,
        version: parsed.version,
        paths: [join(host, entry.name)],
      });
    }
  }
  return [...items, ...others.toItem()];
}

async function enumerateGradleDists(read: DirReader): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];
  const others = new Others();
  for (const entry of await read('')) {
    const dist = entry.isDirectory ? splitGradleDist(entry.name) : null;
    if (!dist) {
      others.add(entry.name);
      continue;
    }
    items.push({
      group: `gradle-${dist.flavour}`,
      groupLabel: `Gradle (${dist.flavour})`,
      version: dist.version,
      paths: [entry.name],
    });
  }
  return [...items, ...others.toItem()];
}

async function enumerateGradleCaches(read: DirReader): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];
  const others = new Others();
  for (const entry of await read('')) {
    if (!entry.isDirectory) {
      others.add(entry.name);
    } else if (isGradleVersionDir(entry.name)) {
      items.push({
        group: 'gradle-version-caches',
        groupLabel: 'Caches per Gradle version',
        version: entry.name,
        paths: [entry.name],
      });
    } else {
      // Areas Gradle shares between versions, such as downloaded dependencies. They have no
      // version, so pruning leaves them alone and only Clear all or a pick removes them.
      items.push({ group: entry.name, groupLabel: entry.name, version: null, paths: [entry.name] });
    }
  }
  return [...items, ...others.toItem()];
}

async function enumeratePlaywright(read: DirReader): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];
  const others = new Others();
  for (const entry of await read('')) {
    // `.links` and `__dirlock` are Playwright's own bookkeeping: never counted, never removed.
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const build = entry.isDirectory ? splitRevisionEntry(entry.name) : null;
    if (!build) {
      others.add(entry.name);
      continue;
    }
    items.push({
      group: build.family,
      groupLabel: build.family,
      version: build.revision,
      paths: [entry.name],
    });
  }
  return [...items, ...others.toItem()];
}

async function enumerateElectron(read: DirReader): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];
  const others = new Others();
  const folders: string[] = [];
  for (const entry of await read('')) {
    const artifact = entry.isDirectory ? null : splitElectronArtifact(entry.name);
    if (artifact) {
      items.push({
        group: artifact.group,
        groupLabel: artifact.group,
        version: artifact.version,
        paths: [entry.name],
      });
    } else if (entry.isDirectory) {
      folders.push(entry.name);
    } else {
      others.add(entry.name);
    }
  }
  const listed = await mapLimited(folders, LIST_PARALLELISM, async (folder) => ({
    folder,
    entries: await read(folder),
  }));
  for (const { folder, entries } of listed) {
    const artifact = entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => splitElectronArtifact(entry.name))
      .find((found) => found !== null);
    if (!artifact) {
      others.add(folder);
      continue;
    }
    items.push({
      group: artifact.group,
      groupLabel: artifact.group,
      version: artifact.version,
      paths: [folder],
    });
  }
  return [...items, ...others.toItem()];
}

async function enumerateNodeGyp(read: DirReader): Promise<EnumeratedItem[]> {
  const items: EnumeratedItem[] = [];
  const others = new Others();
  for (const entry of await read('')) {
    if (entry.isDirectory && parseCacheVersion(entry.name)) {
      items.push({
        group: 'node-gyp',
        groupLabel: 'Node headers',
        version: entry.name,
        paths: [entry.name],
      });
    } else {
      others.add(entry.name);
    }
  }
  return [...items, ...others.toItem()];
}

const GO_DOWNLOAD_FILE = /^(v\d+\.\d+\.\d+.*?)\.(?:info|mod|zip|ziphash|lock)$/;

async function enumerateGoMod(read: DirReader): Promise<EnumeratedItem[]> {
  const byVersion = new Map<string, EnumeratedItem>();
  const others = new Others();

  const add = (modulePath: string, version: string, path: string): void => {
    const key = `${modulePath}@${version}`;
    const existing = byVersion.get(key);
    if (existing) existing.paths.push(path);
    else {
      const readable = decodeGoPath(modulePath);
      byVersion.set(key, { group: readable, groupLabel: readable, version, paths: [path] });
    }
  };

  /** Module versions are folders named `name@vX.Y.Z`; anything else is a step in the path. */
  async function walkModules(rel: string): Promise<void> {
    for (const entry of dirsOf(await read(rel))) {
      const path = join(rel, entry.name);
      if (rel === '' && entry.name === 'cache') continue;
      const parsed = splitGoVersionDir(entry.name);
      if (parsed) add(join(rel, parsed.name), parsed.version, path);
      else await walkModules(path);
    }
  }

  /** Each module's downloads sit in `cache/download/<module path>/@v/`. */
  async function walkDownloads(rel: string, modulePath: string): Promise<void> {
    for (const entry of await read(rel)) {
      const path = join(rel, entry.name);
      if (entry.isDirectory && entry.name === '@v') {
        for (const file of await read(path)) {
          const match = file.isDirectory ? null : GO_DOWNLOAD_FILE.exec(file.name);
          if (match?.[1]) add(modulePath, match[1], join(path, file.name));
        }
      } else if (entry.isDirectory && entry.name !== 'sumdb') {
        await walkDownloads(path, join(modulePath, entry.name));
      }
    }
  }

  await walkModules('');
  await walkDownloads('cache/download', '');
  const cacheEntries = await read('cache');
  if (cacheEntries.some((entry) => entry.isDirectory && entry.name === 'vcs')) {
    others.add('cache/vcs');
  }
  return [...byVersion.values(), ...others.toItem()];
}

// --- The catalog ---------------------------------------------------------------------------

export const CACHE_PROVIDERS: readonly CacheProvider[] = [
  {
    id: 'nuget',
    label: 'NuGet',
    tagline: '.NET packages',
    kind: 'versioned',
    afterClearing: 'The next restore downloads the packages a project needs again.',
    locate: {
      env: [{ name: 'NUGET_PACKAGES' }],
      query: {
        command: 'dotnet',
        args: ['nuget', 'locals', 'global-packages', '--list'],
        parse: labelledPath('global-packages'),
      },
      defaults: {
        win32: ['~/.nuget/packages'],
        darwin: ['~/.nuget/packages'],
        linux: ['~/.nuget/packages'],
      },
    },
    enumerate: enumerateNuget,
    looksLikeCache: nugetLooksRight,
  },
  {
    id: 'nuget-http',
    label: 'NuGet downloads',
    tagline: 'Web requests NuGet remembers',
    kind: 'opaque',
    afterClearing: 'NuGet asks the package servers again the next time it restores.',
    locate: {
      env: [{ name: 'NUGET_HTTP_CACHE_PATH' }],
      query: {
        command: 'dotnet',
        args: ['nuget', 'locals', 'http-cache', '--list'],
        parse: labelledPath('http-cache'),
      },
      defaults: {
        win32: ['%LOCALAPPDATA%/NuGet/v3-cache'],
        darwin: ['~/.local/share/NuGet/http-cache', '~/.local/share/NuGet/v3-cache'],
        linux: [
          '%XDG_DATA_HOME%/NuGet/http-cache',
          '~/.local/share/NuGet/http-cache',
          '~/.local/share/NuGet/v3-cache',
        ],
      },
    },
    clearCommand: {
      label: 'dotnet nuget locals http-cache --clear',
      command: 'dotnet',
      args: ['nuget', 'locals', 'http-cache', '--clear'],
    },
  },
  {
    id: 'bun',
    label: 'Bun',
    tagline: 'JavaScript packages',
    kind: 'versioned',
    afterClearing: 'The next bun install downloads what it needs again.',
    locate: {
      env: [{ name: 'BUN_INSTALL_CACHE_DIR' }, { name: 'BUN_INSTALL', sub: 'install/cache' }],
      query: { command: 'bun', args: ['pm', 'cache'], parse: lastAbsolutePathLine },
      defaults: {
        win32: ['~/.bun/install/cache'],
        darwin: ['~/.bun/install/cache'],
        linux: ['%XDG_CACHE_HOME%/.bun/install/cache', '~/.bun/install/cache'],
      },
    },
    enumerate: enumerateBun,
  },
  {
    id: 'cargo',
    label: 'Cargo',
    tagline: 'Rust crates',
    kind: 'versioned',
    afterClearing: 'The next cargo build downloads the crates it needs again.',
    locate: {
      env: [{ name: 'CARGO_HOME', sub: 'registry' }],
      defaults: {
        win32: ['~/.cargo/registry'],
        darwin: ['~/.cargo/registry'],
        linux: ['~/.cargo/registry'],
      },
    },
    enumerate: enumerateCargo,
  },
  {
    id: 'go-mod',
    label: 'Go modules',
    tagline: 'Go dependencies',
    kind: 'versioned',
    afterClearing: 'The next go build downloads the modules it needs again.',
    locate: {
      env: [{ name: 'GOMODCACHE' }, { name: 'GOPATH', sub: 'pkg/mod', first: true }],
      query: { command: 'go', args: ['env', 'GOMODCACHE'], parse: lastAbsolutePathLine },
      defaults: {
        win32: ['~/go/pkg/mod'],
        darwin: ['~/go/pkg/mod'],
        linux: ['~/go/pkg/mod'],
      },
    },
    enumerate: enumerateGoMod,
  },
  {
    id: 'go-build',
    label: 'Go build cache',
    tagline: 'Compiled Go packages',
    kind: 'opaque',
    afterClearing: 'The next build compiles everything again, which takes longer once.',
    locate: {
      env: [{ name: 'GOCACHE' }],
      query: { command: 'go', args: ['env', 'GOCACHE'], parse: lastAbsolutePathLine },
      defaults: {
        win32: ['%LOCALAPPDATA%/go-build'],
        darwin: ['~/Library/Caches/go-build'],
        linux: ['%XDG_CACHE_HOME%/go-build', '~/.cache/go-build'],
      },
    },
    clearCommand: {
      label: 'go clean -cache',
      command: 'go',
      args: ['clean', '-cache'],
      long: true,
    },
  },
  {
    id: 'pub',
    label: 'Dart and Flutter',
    tagline: 'pub packages',
    kind: 'versioned',
    afterClearing: 'The next pub get downloads the packages a project needs again.',
    locate: {
      env: [{ name: 'PUB_CACHE', sub: 'hosted' }],
      defaults: {
        win32: ['%LOCALAPPDATA%/Pub/Cache/hosted'],
        darwin: ['~/.pub-cache/hosted'],
        linux: ['~/.pub-cache/hosted'],
      },
    },
    enumerate: enumeratePub,
  },
  {
    id: 'gradle-dists',
    label: 'Gradle distributions',
    tagline: 'Gradle versions the wrapper downloaded',
    kind: 'versioned',
    afterClearing: 'A project that uses the wrapper downloads its Gradle version again.',
    locate: {
      env: [{ name: 'GRADLE_USER_HOME', sub: 'wrapper/dists' }],
      defaults: {
        win32: ['~/.gradle/wrapper/dists'],
        darwin: ['~/.gradle/wrapper/dists'],
        linux: ['~/.gradle/wrapper/dists'],
      },
    },
    enumerate: enumerateGradleDists,
  },
  {
    id: 'gradle-caches',
    label: 'Gradle caches',
    tagline: 'Dependencies and build caches',
    kind: 'versioned',
    afterClearing: 'The next Gradle build downloads dependencies and rebuilds its caches.',
    locate: {
      env: [{ name: 'GRADLE_USER_HOME', sub: 'caches' }],
      defaults: {
        win32: ['~/.gradle/caches'],
        darwin: ['~/.gradle/caches'],
        linux: ['~/.gradle/caches'],
      },
    },
    enumerate: enumerateGradleCaches,
  },
  {
    id: 'playwright',
    label: 'Playwright browsers',
    tagline: 'Browsers for testing',
    kind: 'versioned',
    afterClearing: 'Run npx playwright install to download the browsers again.',
    locate: {
      env: [{ name: 'PLAYWRIGHT_BROWSERS_PATH' }],
      defaults: {
        win32: ['%LOCALAPPDATA%/ms-playwright'],
        darwin: ['~/Library/Caches/ms-playwright'],
        linux: ['%XDG_CACHE_HOME%/ms-playwright', '~/.cache/ms-playwright'],
      },
    },
    enumerate: enumeratePlaywright,
  },
  {
    id: 'electron',
    label: 'Electron downloads',
    tagline: 'Electron builds and tools',
    kind: 'versioned',
    afterClearing: 'The next Electron install or package step downloads them again.',
    locate: {
      env: [{ name: 'ELECTRON_CACHE' }],
      defaults: {
        win32: ['%LOCALAPPDATA%/electron/Cache'],
        darwin: ['~/Library/Caches/electron'],
        linux: ['%XDG_CACHE_HOME%/electron', '~/.cache/electron'],
      },
    },
    enumerate: enumerateElectron,
  },
  {
    id: 'node-gyp',
    label: 'node-gyp headers',
    tagline: 'Node headers for native modules',
    kind: 'versioned',
    afterClearing: 'Building a native module downloads the headers it needs again.',
    locate: {
      env: [],
      defaults: {
        win32: ['%LOCALAPPDATA%/node-gyp/Cache'],
        darwin: ['~/Library/Caches/node-gyp'],
        linux: ['%XDG_CACHE_HOME%/node-gyp', '~/.cache/node-gyp'],
      },
    },
    enumerate: enumerateNodeGyp,
  },
  {
    id: 'npm',
    label: 'npm',
    tagline: 'JavaScript packages',
    kind: 'opaque',
    afterClearing: 'The next npm install downloads the packages it needs again.',
    locate: {
      env: [
        { name: 'npm_config_cache', sub: '_cacache' },
        { name: 'NPM_CONFIG_CACHE', sub: '_cacache' },
      ],
      query: {
        command: 'npm',
        args: ['config', 'get', 'cache'],
        parse: lastAbsolutePathLine,
        sub: '_cacache',
      },
      defaults: {
        win32: ['%LOCALAPPDATA%/npm-cache/_cacache'],
        darwin: ['~/.npm/_cacache'],
        linux: ['~/.npm/_cacache'],
      },
    },
    clearCommand: {
      label: 'npm cache clean --force',
      command: 'npm',
      args: ['cache', 'clean', '--force'],
    },
  },
  {
    id: 'pnpm',
    label: 'pnpm',
    tagline: 'JavaScript package store',
    kind: 'opaque',
    afterClearing: 'Projects keep working. Packages nothing uses any more are removed.',
    locate: {
      env: [{ name: 'npm_config_store_dir' }],
      query: { command: 'pnpm', args: ['store', 'path'], parse: lastAbsolutePathLine },
      defaults: {
        win32: ['%LOCALAPPDATA%/pnpm/store'],
        darwin: ['~/Library/pnpm/store'],
        linux: ['%XDG_DATA_HOME%/pnpm/store', '~/.local/share/pnpm/store'],
      },
    },
    tidyCommand: {
      label: 'pnpm store prune',
      command: 'pnpm',
      args: ['store', 'prune'],
      long: true,
    },
  },
  {
    id: 'pip',
    label: 'pip',
    tagline: 'Python packages',
    kind: 'opaque',
    afterClearing: 'The next pip install downloads the packages it needs again.',
    locate: {
      env: [{ name: 'PIP_CACHE_DIR' }],
      query: { command: 'pip', args: ['cache', 'dir'], parse: lastAbsolutePathLine },
      defaults: {
        win32: ['%LOCALAPPDATA%/pip/Cache'],
        darwin: ['~/Library/Caches/pip'],
        linux: ['%XDG_CACHE_HOME%/pip', '~/.cache/pip'],
      },
    },
    clearCommand: { label: 'pip cache purge', command: 'pip', args: ['cache', 'purge'] },
  },
];

const BY_ID = new Map<CacheProviderId, CacheProvider>(
  CACHE_PROVIDERS.map((provider) => [provider.id, provider]),
);

export function getProvider(id: CacheProviderId): CacheProvider {
  const provider = BY_ID.get(id);
  if (!provider) throw new Error(`Unknown cache: ${String(id)}`);
  return provider;
}

/** A reader that never shows a folder the app has set aside to delete. */
function withoutTrash(read: DirReader): DirReader {
  return async (relPath) =>
    (await read(relPath)).filter((entry) => !entry.name.includes(TRASH_MARK));
}

/** What a provider's cache holds, as a list of things that can be removed on their own. */
export async function enumerateProvider(
  provider: CacheProvider,
  read: DirReader,
): Promise<EnumeratedItem[]> {
  if (!provider.enumerate) return [];
  return provider.enumerate(withoutTrash(read));
}
