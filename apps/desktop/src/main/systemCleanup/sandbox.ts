import { type DevOs, pathFlavour } from '@runova/core';

/**
 * Keeps test runs away from real caches. Disk Cleanup deletes things, so a test run of the app
 * must never be able to see the developer's own NuGet or Gradle cache, let alone clean it.
 *
 * Under the end-to-end harness the feature is off unless the test hands it a folder of its own.
 * With one, the home folder and the places tools put caches (local app data, the XDG folders) are
 * swapped for ones inside it, and every variable that moves a cache is dropped, so the only caches
 * it can find are the ones the test built. It only turns on when the app is running under the
 * harness AND is given an absolute folder, so a stray variable on a real install does nothing.
 *
 * This mirrors the Dev Setup sandbox, which does the same for the tool checklist.
 */

export interface CleanupSandbox {
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface CleanupAvailability {
  enabled: boolean;
  /** In words, when it is off. */
  reason?: string;
  sandbox: CleanupSandbox | null;
}

export interface SandboxInput {
  isE2E: boolean;
  /** `RUNOVA_CLEANUP_SANDBOX`. */
  folder: string | undefined;
  baseEnv: NodeJS.ProcessEnv;
  os: DevOs;
}

/** Every variable that moves a cache, so none of them can point a test at a real one. */
const CACHE_VARIABLES = [
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

function keyOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
}

function set(env: NodeJS.ProcessEnv, name: string, value: string): void {
  env[keyOf(env, name) ?? name] = value;
}

function forget(env: NodeJS.ProcessEnv, name: string): void {
  const key = keyOf(env, name);
  if (key) delete env[key];
}

export function cleanupAvailability(input: SandboxInput): CleanupAvailability {
  if (!input.isE2E) return { enabled: true, sandbox: null };

  const folder = input.folder?.trim();
  const path = pathFlavour(input.os);
  if (!folder || !path.isAbsolute(folder)) {
    return {
      enabled: false,
      reason: 'Test runs leave it switched off, so a test can never touch real caches.',
      sandbox: null,
    };
  }

  const env: NodeJS.ProcessEnv = { ...input.baseEnv };
  const home = path.join(folder, 'home');
  set(env, 'HOME', home);
  if (input.os === 'win32') {
    set(env, 'USERPROFILE', home);
    set(env, 'LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
    set(env, 'APPDATA', path.join(home, 'AppData', 'Roaming'));
  }
  for (const name of CACHE_VARIABLES) forget(env, name);
  return { enabled: true, sandbox: { env, home } };
}
