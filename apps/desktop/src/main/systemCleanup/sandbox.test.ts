import { describe, expect, it } from 'vitest';
import { cleanupAvailability } from './sandbox';

const winBase = {
  Path: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\real',
  HOME: 'C:\\Users\\real',
  LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local',
  APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
  NUGET_PACKAGES: 'D:\\real-nuget',
  GOPATH: 'D:\\go',
  CARGO_HOME: 'D:\\cargo',
  XDG_CACHE_HOME: '/real/cache',
};

describe('cleanupAvailability', () => {
  it('is on, with nothing swapped, when this is not a test run', () => {
    expect(
      cleanupAvailability({ isE2E: false, folder: undefined, baseEnv: winBase, os: 'win32' }),
    ).toEqual({ enabled: true, sandbox: null });
  });

  it('ignores the sandbox variable outside a test run, so a stray one on a real install does nothing', () => {
    expect(
      cleanupAvailability({ isE2E: false, folder: 'C:\\sandbox', baseEnv: winBase, os: 'win32' }),
    ).toEqual({ enabled: true, sandbox: null });
  });

  it('is off in a test run that was given no sandbox, so a test can never reach real caches', () => {
    const result = cleanupAvailability({
      isE2E: true,
      folder: undefined,
      baseEnv: winBase,
      os: 'win32',
    });
    expect(result.enabled).toBe(false);
    expect(result.sandbox).toBeNull();
    expect(result.reason).toMatch(/test/i);
  });

  it('is off when the sandbox folder is empty or is not a full path', () => {
    for (const folder of ['', '   ', 'relative\\sandbox']) {
      const result = cleanupAvailability({ isE2E: true, folder, baseEnv: winBase, os: 'win32' });
      expect(result.enabled, folder).toBe(false);
    }
    const posix = cleanupAvailability({
      isE2E: true,
      folder: 'sandbox/here',
      baseEnv: {},
      os: 'linux',
    });
    expect(posix.enabled).toBe(false);
  });

  it('moves the home folder and the app data folders into the sandbox on Windows', () => {
    const result = cleanupAvailability({
      isE2E: true,
      folder: 'C:\\sandbox',
      baseEnv: winBase,
      os: 'win32',
    });
    expect(result.enabled).toBe(true);
    expect(result.sandbox?.home).toBe('C:\\sandbox\\home');
    expect(result.sandbox?.env).toMatchObject({
      HOME: 'C:\\sandbox\\home',
      USERPROFILE: 'C:\\sandbox\\home',
      LOCALAPPDATA: 'C:\\sandbox\\home\\AppData\\Local',
      APPDATA: 'C:\\sandbox\\home\\AppData\\Roaming',
    });
  });

  it('forgets every variable that names a real cache', () => {
    const result = cleanupAvailability({
      isE2E: true,
      folder: 'C:\\sandbox',
      baseEnv: winBase,
      os: 'win32',
    });
    const env = result.sandbox?.env ?? {};
    for (const name of ['NUGET_PACKAGES', 'GOPATH', 'CARGO_HOME', 'XDG_CACHE_HOME']) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('forgets variables however their names are cased on Windows', () => {
    const result = cleanupAvailability({
      isE2E: true,
      folder: 'C:\\sandbox',
      baseEnv: { nuget_packages: 'D:\\real', Gradle_User_Home: 'D:\\gradle' },
      os: 'win32',
    });
    const names = Object.keys(result.sandbox?.env ?? {}).map((name) => name.toLowerCase());
    expect(names).not.toContain('nuget_packages');
    expect(names).not.toContain('gradle_user_home');
  });

  it('knows every variable a cache can be moved with', () => {
    const everything = [
      'NUGET_PACKAGES',
      'NUGET_HTTP_CACHE_PATH',
      'BUN_INSTALL_CACHE_DIR',
      'BUN_INSTALL',
      'CARGO_HOME',
      'GOMODCACHE',
      'GOPATH',
      'GOCACHE',
      'PUB_CACHE',
      'GRADLE_USER_HOME',
      'PLAYWRIGHT_BROWSERS_PATH',
      'ELECTRON_CACHE',
      'npm_config_cache',
      'NPM_CONFIG_CACHE',
      'npm_config_store_dir',
      'PIP_CACHE_DIR',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
    ];
    const baseEnv = Object.fromEntries(everything.map((name) => [name, '/real']));
    const result = cleanupAvailability({ isE2E: true, folder: '/sandbox', baseEnv, os: 'linux' });
    for (const name of everything) expect(result.sandbox?.env[name], name).toBeUndefined();
  });

  it('works the same way off Windows', () => {
    const result = cleanupAvailability({
      isE2E: true,
      folder: '/tmp/sandbox',
      baseEnv: { HOME: '/home/real', XDG_CACHE_HOME: '/home/real/.cache', PATH: '/usr/bin' },
      os: 'linux',
    });
    expect(result.sandbox?.home).toBe('/tmp/sandbox/home');
    expect(result.sandbox?.env.HOME).toBe('/tmp/sandbox/home');
    expect(result.sandbox?.env.XDG_CACHE_HOME).toBeUndefined();
    expect(result.sandbox?.env.PATH).toBe('/usr/bin');
  });

  it('does not change the environment it was given', () => {
    const baseEnv = { ...winBase };
    cleanupAvailability({ isE2E: true, folder: 'C:\\sandbox', baseEnv, os: 'win32' });
    expect(baseEnv).toEqual(winBase);
  });
});
