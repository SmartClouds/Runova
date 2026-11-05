import { describe, expect, it } from 'vitest';
import {
  CACHE_PROVIDERS,
  enumerateProvider,
  getProvider,
  OTHER_GROUP,
  TRASH_MARK,
} from './providers.js';
import { memoryReader, type TreeSpec } from './testTree.js';
import type { CacheProviderId, EnumeratedItem } from './types.js';

async function listItems(id: CacheProviderId, tree: TreeSpec): Promise<EnumeratedItem[]> {
  return enumerateProvider(getProvider(id), memoryReader(tree));
}

/** Compares what was found with a list, ignoring order. */
function expectFound(items: EnumeratedItem[], expected: string[]): void {
  expect(summary(items)).toEqual([...expected].sort());
}

/** One line per item (group, version, paths), so a test reads as the list of what was found. */
function summary(items: EnumeratedItem[]): string[] {
  return items
    .map((item) => `${item.group} ${item.version ?? '-'} ${[...item.paths].sort().join(' + ')}`)
    .sort();
}

describe('the provider catalog', () => {
  it('has one provider per id, and every id is known', () => {
    const ids = CACHE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      [
        'bun',
        'cargo',
        'electron',
        'go-build',
        'go-mod',
        'gradle-caches',
        'gradle-dists',
        'node-gyp',
        'npm',
        'nuget',
        'nuget-http',
        'pip',
        'playwright',
        'pnpm',
        'pub',
      ].sort(),
    );
  });

  it('can look a provider up, and refuses an unknown one', () => {
    expect(getProvider('bun').label).toBe('Bun');
    expect(() => getProvider('nope' as CacheProviderId)).toThrow(/unknown cache/i);
  });

  it('gives a versioned cache a way to list its contents and an opaque one a command', () => {
    for (const provider of CACHE_PROVIDERS) {
      if (provider.kind === 'versioned') {
        expect(provider.enumerate, provider.id).toBeTypeOf('function');
      } else {
        expect(provider.enumerate, provider.id).toBeUndefined();
        expect(provider.clearCommand ?? provider.tidyCommand, provider.id).toBeDefined();
      }
    }
  });

  it('says where each cache usually lives on every system', () => {
    for (const provider of CACHE_PROVIDERS) {
      for (const os of ['win32', 'darwin', 'linux'] as const) {
        expect(provider.locate.defaults[os].length, `${provider.id} on ${os}`).toBeGreaterThan(0);
      }
    }
  });

  it('only ever asks a handful of tools where their cache is', () => {
    const asked = CACHE_PROVIDERS.flatMap((provider) =>
      provider.locate.query ? [provider.locate.query.command] : [],
    );
    expect(new Set(asked)).toEqual(new Set(['npm', 'pnpm', 'bun', 'dotnet', 'pip', 'go']));
  });

  it('never runs a tool that might start a daemon or download something just to find a path', () => {
    const queried = CACHE_PROVIDERS.flatMap((provider) =>
      provider.locate.query ? [provider.locate.query.command] : [],
    );
    for (const banned of ['gradle', 'gradlew', 'mvn', 'flutter', 'dart']) {
      expect(queried).not.toContain(banned);
    }
  });
});

describe('enumerateProvider', () => {
  it('ignores a folder this app has set aside to delete', async () => {
    const items = await listItems('nuget', {
      acornima: { '1.0.0': {}, [`1.0.0${TRASH_MARK}ab12cd`]: {} },
      [`gone${TRASH_MARK}ff00`]: { '1.0.0': {} },
    });
    expectFound(items, ['acornima 1.0.0 acornima/1.0.0']);
  });

  it('gives a provider with nothing in it an empty list', async () => {
    expect(await listItems('nuget', {})).toEqual([]);
  });
});

describe('NuGet global packages', () => {
  it('lists each version of each package and sets the rest aside', async () => {
    const items = await listItems('nuget', {
      acornima: { '1.0.0': {}, '2.0.0-rc.1': {} },
      'Abstractions.Sass': { '1.1.52': {} },
      '.tools': { thing: {} },
      'readme.txt': null,
    });
    expectFound(items, [
      `${OTHER_GROUP} - .tools + readme.txt`,
      'abstractions.sass 1.1.52 Abstractions.Sass/1.1.52',
      'acornima 1.0.0 acornima/1.0.0',
      'acornima 2.0.0-rc.1 acornima/2.0.0-rc.1',
    ]);
    expect(items.find((item) => item.group === 'abstractions.sass')?.groupLabel).toBe(
      'Abstractions.Sass',
    );
  });

  it('has no other-files entry when everything was a package', async () => {
    const items = await listItems('nuget', { acornima: { '1.0.0': {} } });
    expect(items.map((item) => item.group)).toEqual(['acornima']);
  });
});

describe('Bun cache', () => {
  it('lists package versions, scoped ones too, and gathers the entries with no version', async () => {
    const items = await listItems('bun', {
      'react@19.2.8@@@1': {},
      'react@19.3.0@@@1': {},
      '@types': { 'node@22.1.0@@@1': {}, 'node@24.0.0@@@1': {} },
      '@GH@jonschlinkert-is-number-98e8ff1@@@1': {},
      '@T@55a80cc6eed2cd5c@@@1': {},
      '00000e5c40626918.npm': null,
      '0019245d1f12eeb3.npm': null,
    });
    expectFound(items, [
      '@types/node 22.1.0 @types/node@22.1.0@@@1',
      '@types/node 24.0.0 @types/node@24.0.0@@@1',
      `${OTHER_GROUP} - 00000e5c40626918.npm + 0019245d1f12eeb3.npm + @GH@jonschlinkert-is-number-98e8ff1@@@1 + @T@55a80cc6eed2cd5c@@@1`,
      'react 19.2.8 react@19.2.8@@@1',
      'react 19.3.0 react@19.3.0@@@1',
    ]);
  });
});

describe('Cargo registry', () => {
  const index = 'index.crates.io-1949cf8c6b5b557f';

  it('joins a crate file and its unpacked source into one version', async () => {
    const items = await listItems('cargo', {
      cache: {
        [index]: {
          'rand_core-0.6.4.crate': null,
          'serde-1.0.200.crate': null,
          'serde-1.0.210.crate': null,
        },
      },
      src: { [index]: { 'rand_core-0.6.4': {}, 'serde-1.0.200': {} } },
      index: { [index]: {} },
    });
    expectFound(items, [
      `${OTHER_GROUP} - index`,
      `${index}/rand_core 0.6.4 cache/${index}/rand_core-0.6.4.crate + src/${index}/rand_core-0.6.4`,
      `${index}/serde 1.0.200 cache/${index}/serde-1.0.200.crate + src/${index}/serde-1.0.200`,
      `${index}/serde 1.0.210 cache/${index}/serde-1.0.210.crate`,
    ]);
    expect(items.find((item) => item.version === '0.6.4')?.groupLabel).toBe('rand_core');
  });

  it('finds sources whose crate file is gone', async () => {
    const items = await listItems('cargo', { src: { [index]: { 'serde-1.0.200': {} } } });
    expectFound(items, [`${index}/serde 1.0.200 src/${index}/serde-1.0.200`]);
  });
});

describe('Dart and Flutter pub cache', () => {
  it('keeps the same package from two hosts apart', async () => {
    const items = await listItems('pub', {
      'pub.dev': {
        '_fe_analyzer_shared-103.0.0': {},
        '_fe_analyzer_shared-108.0.0': {},
        'archive-3.6.1': {},
      },
      'pub.flutter-io.cn': { 'archive-3.6.1': {} },
      '.stray': null,
    });
    expectFound(items, [
      `${OTHER_GROUP} - .stray`,
      'pub.dev/_fe_analyzer_shared 103.0.0 pub.dev/_fe_analyzer_shared-103.0.0',
      'pub.dev/_fe_analyzer_shared 108.0.0 pub.dev/_fe_analyzer_shared-108.0.0',
      'pub.dev/archive 3.6.1 pub.dev/archive-3.6.1',
      'pub.flutter-io.cn/archive 3.6.1 pub.flutter-io.cn/archive-3.6.1',
    ]);
    expect(items.find((item) => item.group === 'pub.flutter-io.cn/archive')?.groupLabel).toBe(
      'archive (pub.flutter-io.cn)',
    );
    expect(items.find((item) => item.group === 'pub.dev/archive')?.groupLabel).toBe('archive');
  });

  it('sets aside a package folder with no version in its name', async () => {
    const items = await listItems('pub', { 'pub.dev': { 'archive-3.6.1': {}, odd: {} } });
    expectFound(items, [
      `${OTHER_GROUP} - pub.dev/odd`,
      'pub.dev/archive 3.6.1 pub.dev/archive-3.6.1',
    ]);
  });
});

describe('Gradle', () => {
  it('lists distributions by flavour, so bin and all do not compete', async () => {
    const items = await listItems('gradle-dists', {
      'gradle-9.4.1-bin': { hash1: {} },
      'gradle-9.3.1-all': { hash2: {} },
      'gradle-9.3.1-bin': { hash3: {} },
      weird: {},
    });
    expectFound(items, [
      `${OTHER_GROUP} - weird`,
      'gradle-all 9.3.1 gradle-9.3.1-all',
      'gradle-bin 9.3.1 gradle-9.3.1-bin',
      'gradle-bin 9.4.1 gradle-9.4.1-bin',
    ]);
  });

  it('prunes per-version caches but lists the shared areas on their own, with no version', async () => {
    const items = await listItems('gradle-caches', {
      '8.14.3': {},
      '9.4.1': {},
      'modules-2': {},
      'jars-9': {},
      'CACHEDIR.TAG': null,
    });
    expectFound(items, [
      `${OTHER_GROUP} - CACHEDIR.TAG`,
      'gradle-version-caches 8.14.3 8.14.3',
      'gradle-version-caches 9.4.1 9.4.1',
      'jars-9 - jars-9',
      'modules-2 - modules-2',
    ]);
  });
});

describe('Playwright browsers', () => {
  it('groups builds by browser family and leaves its bookkeeping alone', async () => {
    const items = await listItems('playwright', {
      'chromium-1134': {},
      'chromium-1234': {},
      'chromium_headless_shell-1243': {},
      'ffmpeg-1011': {},
      '.links': null,
      __dirlock: null,
      mystery: {},
    });
    expectFound(items, [
      `${OTHER_GROUP} - mystery`,
      'chromium 1134 chromium-1134',
      'chromium 1234 chromium-1234',
      'chromium_headless_shell 1243 chromium_headless_shell-1243',
      'ffmpeg 1011 ffmpeg-1011',
    ]);
  });
});

describe('Electron downloads', () => {
  it('reads the version from the zip inside each hashed folder', async () => {
    const items = await listItems('electron', {
      sha1: { 'electron-v43.1.1-win32-x64.zip': null },
      sha2: { 'electron-v42.0.0-win32-x64.zip': null, 'SHASUMS256.txt': null },
      sha3: { 'notes.txt': null },
      'electron-v41.0.0-win32-x64.zip': null,
    });
    expectFound(items, [
      `${OTHER_GROUP} - sha3`,
      'electron-win32-x64 41.0.0 electron-v41.0.0-win32-x64.zip',
      'electron-win32-x64 42.0.0 sha2',
      'electron-win32-x64 43.1.1 sha1',
    ]);
  });
});

describe('node-gyp headers', () => {
  it('lists each Node version and sets odd folders aside', async () => {
    const items = await listItems('node-gyp', { '24.15.0': {}, '26.13.0': {}, junk: {} });
    expectFound(items, [
      `${OTHER_GROUP} - junk`,
      'node-gyp 24.15.0 24.15.0',
      'node-gyp 26.13.0 26.13.0',
    ]);
  });
});

describe('Go module cache', () => {
  const dl = 'cache/download/golang.org/x/net/@v';

  it('lists module versions with their downloads, decodes capitals and skips the cache folder', async () => {
    const items = await listItems('go-mod', {
      'github.com': {
        '!azure': { 'sdk@v1.0.0': {}, 'sdk@v1.1.0': {} },
        foo: { 'bar@v2.0.0+incompatible': {} },
      },
      'golang.org': { x: { 'net@v0.19.0': {}, 'net@v0.20.0': {} } },
      cache: {
        download: {
          'golang.org': {
            x: {
              net: {
                '@v': {
                  'v0.19.0.info': null,
                  'v0.19.0.mod': null,
                  'v0.19.0.zip': null,
                  'v0.19.0.ziphash': null,
                  'v0.19.0.lock': null,
                  list: null,
                },
              },
            },
          },
        },
        vcs: { abc: {} },
      },
    });
    expectFound(items, [
      `${OTHER_GROUP} - cache/vcs`,
      'github.com/Azure/sdk v1.0.0 github.com/!azure/sdk@v1.0.0',
      'github.com/Azure/sdk v1.1.0 github.com/!azure/sdk@v1.1.0',
      'github.com/foo/bar v2.0.0+incompatible github.com/foo/bar@v2.0.0+incompatible',
      `golang.org/x/net v0.19.0 ${dl}/v0.19.0.info + ${dl}/v0.19.0.lock + ${dl}/v0.19.0.mod + ${dl}/v0.19.0.zip + ${dl}/v0.19.0.ziphash + golang.org/x/net@v0.19.0`,
      'golang.org/x/net v0.20.0 golang.org/x/net@v0.20.0',
    ]);
  });

  it('finds a download that was never unpacked', async () => {
    const items = await listItems('go-mod', {
      cache: {
        download: { 'example.com': { lib: { '@v': { 'v1.0.0.zip': null, 'v1.0.0.info': null } } } },
      },
    });
    expectFound(items, [
      'example.com/lib v1.0.0 cache/download/example.com/lib/@v/v1.0.0.info + cache/download/example.com/lib/@v/v1.0.0.zip',
    ]);
  });
});

describe('looksLikeCache', () => {
  const nuget = getProvider('nuget');

  it('accepts a NuGet folder whose versions hold package files', async () => {
    const read = memoryReader({
      acornima: { '1.0.0': { 'acornima.1.0.0.nupkg': null, '.nupkg.metadata': null } },
    });
    const items = await enumerateProvider(nuget, read);
    expect(await nuget.looksLikeCache?.(read, items)).toBe(true);
  });

  it('accepts one that has only the newer metadata file', async () => {
    const read = memoryReader({ acornima: { '1.0.0': { 'acornima.1.0.0.nupkg.metadata': null } } });
    const items = await enumerateProvider(nuget, read);
    expect(await nuget.looksLikeCache?.(read, items)).toBe(true);
  });

  it('refuses a folder of ordinary folders, such as a Projects folder named by mistake', async () => {
    const read = memoryReader({
      Website: { src: { 'index.html': null }, docs: { 'readme.md': null } },
      Notes: { 2024: { 'jan.txt': null } },
    });
    const items = await enumerateProvider(nuget, read);
    expect(items.length).toBeGreaterThan(0);
    expect(await nuget.looksLikeCache?.(read, items)).toBe(false);
  });

  it('has nothing to object to in an empty folder', async () => {
    const read = memoryReader({});
    expect(await nuget.looksLikeCache?.(read, [])).toBe(true);
  });

  it('looks at a few versions, not all of them', async () => {
    const tree: Record<string, Record<string, Record<string, null>>> = {};
    for (let index = 0; index < 40; index += 1) tree[`pkg${index}`] = { '1.0.0': { 'x.txt': null } };
    const read = memoryReader(tree);
    const items = await enumerateProvider(nuget, read);
    read.reads.length = 0;
    await nuget.looksLikeCache?.(read, items);
    expect(read.reads.length).toBeLessThanOrEqual(5);
  });
});

