import { describe, expect, it } from 'vitest';
import { candidateRoots, type LocateContext } from './locate.js';
import { getProvider } from './providers.js';
import type { CacheProviderId } from './types.js';

const win: LocateContext = {
  os: 'win32',
  home: 'C:\\Users\\me',
  env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
};
const linux: LocateContext = { os: 'linux', home: '/home/me', env: {} };
const mac: LocateContext = { os: 'darwin', home: '/Users/me', env: {} };

function roots(id: CacheProviderId, ctx: LocateContext, queried?: string | null): string[] {
  return candidateRoots(getProvider(id), ctx, queried).map((candidate) => candidate.path);
}

describe('candidateRoots', () => {
  it('falls back to where the tool keeps its cache by default', () => {
    expect(roots('nuget', win)).toEqual(['C:\\Users\\me\\.nuget\\packages']);
    expect(roots('playwright', win)).toEqual(['C:\\Users\\me\\AppData\\Local\\ms-playwright']);
    expect(roots('bun', linux)).toEqual(['/home/me/.bun/install/cache']);
    expect(roots('playwright', mac)).toEqual(['/Users/me/Library/Caches/ms-playwright']);
  });

  it('puts the environment variable first, and the usual place after it', () => {
    const found = candidateRoots(getProvider('nuget'), {
      ...win,
      env: { ...win.env, NUGET_PACKAGES: 'D:\\nuget' },
    });
    expect(found).toEqual([
      { path: 'D:\\nuget', source: 'env' },
      { path: 'C:\\Users\\me\\.nuget\\packages', source: 'default' },
    ]);
  });

  it('reads Windows variable names without regard to case', () => {
    expect(roots('nuget', { ...win, env: { nuget_packages: 'D:\\nuget' } })[0]).toBe('D:\\nuget');
  });

  it('leaves out a value that is not an absolute path', () => {
    expect(roots('nuget', { ...win, env: { ...win.env, NUGET_PACKAGES: 'packages' } })).toEqual([
      'C:\\Users\\me\\.nuget\\packages',
    ]);
    // Playwright reads 0 as "inside node_modules", which is not a shared cache.
    expect(
      roots('playwright', { ...win, env: { ...win.env, PLAYWRIGHT_BROWSERS_PATH: '0' } }),
    ).toEqual(['C:\\Users\\me\\AppData\\Local\\ms-playwright']);
  });

  it('appends the folder that holds the cache inside a tool home', () => {
    expect(roots('cargo', { ...win, env: { CARGO_HOME: 'D:\\cargo' } })[0]).toBe(
      'D:\\cargo\\registry',
    );
    expect(roots('gradle-dists', { ...linux, env: { GRADLE_USER_HOME: '/opt/gradle' } })[0]).toBe(
      '/opt/gradle/wrapper/dists',
    );
    expect(roots('bun', { ...linux, env: { BUN_INSTALL: '/opt/bun' } })[0]).toBe(
      '/opt/bun/install/cache',
    );
  });

  it('prefers the module cache variable over the Go path, and takes the first Go path', () => {
    expect(roots('go-mod', { ...win, env: { GOMODCACHE: 'D:\\mods', GOPATH: 'E:\\go' } })[0]).toBe(
      'D:\\mods',
    );
    expect(roots('go-mod', { ...win, env: { GOPATH: 'E:\\go;F:\\other' } })[0]).toBe(
      'E:\\go\\pkg\\mod',
    );
    expect(roots('go-mod', { ...linux, env: { GOPATH: '/srv/go:/srv/other' } })[0]).toBe(
      '/srv/go/pkg/mod',
    );
  });

  it("uses the tool's own answer, after the variables and before the usual place", () => {
    const found = candidateRoots(
      getProvider('nuget'),
      win,
      'global-packages: D:\\somewhere\\packages\\\r\n',
    );
    expect(found.map((candidate) => [candidate.path, candidate.source])).toEqual([
      ['D:\\somewhere\\packages', 'query'],
      ['C:\\Users\\me\\.nuget\\packages', 'default'],
    ]);
  });

  it('adds the folder inside the answer for npm, whose cache folder holds more than the cache', () => {
    expect(roots('npm', win, 'C:\\Users\\me\\AppData\\Local\\npm-cache\r\n')[0]).toBe(
      'C:\\Users\\me\\AppData\\Local\\npm-cache\\_cacache',
    );
    expect(roots('npm', linux, '/home/me/.npm\n')[0]).toBe('/home/me/.npm/_cacache');
  });

  it('ignores an answer it cannot read', () => {
    expect(roots('npm', linux, 'npm ERR! something\n')).toEqual(['/home/me/.npm/_cacache']);
    expect(roots('npm', linux, null)).toEqual(['/home/me/.npm/_cacache']);
  });

  it('skips a usual place that needs a variable that is not set', () => {
    expect(roots('go-build', linux)).toEqual(['/home/me/.cache/go-build']);
    expect(roots('go-build', { ...linux, env: { XDG_CACHE_HOME: '/data/cache' } })).toEqual([
      '/data/cache/go-build',
      '/home/me/.cache/go-build',
    ]);
  });

  it('lists a place once, even when a variable and the default say the same thing', () => {
    const found = candidateRoots(getProvider('nuget'), {
      ...win,
      env: { ...win.env, NUGET_PACKAGES: 'c:/users/ME/.nuget/packages/' },
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.source).toBe('env');
  });

  it('writes Windows paths with backslashes and no trailing separator', () => {
    expect(roots('nuget', { ...win, env: { NUGET_PACKAGES: 'D:/caches/nuget/' } })[0]).toBe(
      'D:\\caches\\nuget',
    );
  });

  it('keeps names that differ only by case apart on Linux', () => {
    const found = candidateRoots(getProvider('cargo'), {
      ...linux,
      env: { CARGO_HOME: '/home/me/.CARGO' },
    });
    expect(found.map((candidate) => candidate.path)).toEqual([
      '/home/me/.CARGO/registry',
      '/home/me/.cargo/registry',
    ]);
  });
});

describe('reading what a tool prints', () => {
  const parse = (id: CacheProviderId, output: string): string | null =>
    getProvider(id).locate.query?.parse(output) ?? null;

  it('finds the folder in the last line that is a path', () => {
    expect(parse('bun', 'C:\\Users\\me\\.bun\\install\\cache')).toBe(
      'C:\\Users\\me\\.bun\\install\\cache',
    );
    expect(parse('go-mod', 'go: downloading something\n/home/me/go/pkg/mod\n')).toBe(
      '/home/me/go/pkg/mod',
    );
    expect(parse('pip', 'c:\\users\\me\\appdata\\local\\pip\\cache\r\n')).toBe(
      'c:\\users\\me\\appdata\\local\\pip\\cache',
    );
    expect(parse('pnpm', '\\\\server\\share\\pnpm\\store\\v10')).toBe(
      '\\\\server\\share\\pnpm\\store\\v10',
    );
  });

  it('finds nothing when no line is a path', () => {
    expect(parse('bun', 'error: not found')).toBeNull();
    expect(parse('bun', '')).toBeNull();
  });

  it('reads the labelled lines dotnet prints, and the last one if there are several', () => {
    const output =
      'http-cache: C:\\Users\\me\\AppData\\Local\\NuGet\\v3-cache\r\n' +
      'global-packages: C:\\Users\\me\\.nuget\\packages\\\r\n' +
      'temp: C:\\Users\\me\\AppData\\Local\\Temp\\NuGetScratch\r\n';
    expect(parse('nuget', output)).toBe('C:\\Users\\me\\.nuget\\packages\\');
    expect(parse('nuget-http', output)).toBe('C:\\Users\\me\\AppData\\Local\\NuGet\\v3-cache');
    expect(parse('nuget', 'nothing useful')).toBeNull();
  });
});
