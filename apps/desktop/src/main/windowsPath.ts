import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';

/** PATH rarely changes, so reading it back more often than this only costs reg.exe runs. */
const REFRESH_THROTTLE_MS = 30_000;
let lastRefreshAt = 0;
let refreshing: Promise<void> | null = null;

export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function regQueryPath(hive: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', hive, '/v', 'Path'],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const match = /\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(stdout);
        const value = (match?.[1] ?? '').trim().replace(/%([^%]+)%/g, (whole, name: string) => {
          const key = Object.keys(process.env).find((k) => k.toUpperCase() === name.toUpperCase());
          return key ? (process.env[key] ?? whole) : whole;
        });
        resolve(value.split(';').filter(Boolean));
      },
    );
  });
}

/**
 * The app keeps the PATH it started with, so a CLI installed (or a PATH entry added) after that
 * showed as missing for the whole session while a new cmd window found it. On Windows the current
 * PATH is read back from the registry and any new folders are added to this process's PATH, which
 * also lets what the app starts from here on find the CLI.
 */
export async function refreshWindowsPath({ force = false } = {}): Promise<void> {
  if (process.platform !== 'win32') return;
  // An e2e run that brings its own home (the website screenshots) brings its own PATH too, and
  // the registry would add this machine's real CLIs back. See testMode.ts.
  if (process.env.RUNOVA_E2E === '1' && process.env.RUNOVA_E2E_HOME?.trim()) return;
  // A sweep for any usable CLI can miss a dozen in a row, and each miss asks for a refresh.
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;
  refreshing = readRegistryPath().finally(() => {
    lastRefreshAt = Date.now();
    refreshing = null;
  });
  return refreshing;
}

async function readRegistryPath(): Promise<void> {
  const [machine, user] = await Promise.all([
    regQueryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    regQueryPath('HKCU\\Environment'),
  ]);
  const key = pathKey(process.env);
  const current = (process.env[key] ?? '').split(delimiter).filter(Boolean);
  const known = new Set(current.map((dir) => dir.toLowerCase().replace(/[\\/]+$/, '')));
  const added = [...machine, ...user].filter((dir) => {
    const normalized = dir.toLowerCase().replace(/[\\/]+$/, '');
    if (known.has(normalized)) return false;
    known.add(normalized);
    return true;
  });
  if (added.length > 0) process.env[key] = [...current, ...added].join(delimiter);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_ENV = 'HKCU\\Environment';
const MACHINE_ENV = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

function regQueryValue(hive: string, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', hive, '/v', name],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const match = new RegExp(`\\b${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`, 'i').exec(stdout);
        const value = match?.[1]?.trim().replace(/%([^%]+)%/g, (whole, variable: string) => {
          const key = Object.keys(process.env).find(
            (k) => k.toUpperCase() === variable.toUpperCase(),
          );
          return key ? (process.env[key] ?? whole) : whole;
        });
        resolve(value || null);
      },
    );
  });
}

/**
 * Reads variables an installer has just set (JAVA_HOME, ANDROID_HOME, DOTNET_ROOT...) back from
 * the registry into this process, the way `refreshWindowsPath` does for PATH. A variable the app
 * already has is left alone, so nothing a person set for this session is replaced, and the user's
 * value wins over the machine's as it does for a new terminal.
 */
export async function refreshWindowsEnvVars(names: readonly string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  for (const name of names) {
    // These names go onto a command line, so only something shaped like a variable gets that far.
    if (!ENV_NAME.test(name)) continue;
    const existing = Object.keys(process.env).find(
      (key) => key.toUpperCase() === name.toUpperCase(),
    );
    if (existing && process.env[existing]) continue;
    const value = (await regQueryValue(USER_ENV, name)) ?? (await regQueryValue(MACHINE_ENV, name));
    if (value) process.env[name] = value;
  }
}
