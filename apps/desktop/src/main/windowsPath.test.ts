import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After an installer sets JAVA_HOME or ANDROID_HOME, the app still holds the environment it started
 * with, so the next probe would not see them. These read the new values back from the registry
 * without ever replacing one the app already has.
 */

type ExecCallback = (error: Error | null, stdout: string) => void;
const exec = vi.hoisted(() => ({
  execFile: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: exec.execFile }));

/** What `reg query <hive> /v <name>` would print, per hive and name. */
function registry(values: Record<string, Record<string, string>>): void {
  exec.execFile.mockImplementation(
    (_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
      const [, hive = '', , name = ''] = args;
      const value = values[hive]?.[name];
      if (value === undefined) {
        callback(
          new Error('The system was unable to find the specified registry key or value.'),
          '',
        );
        return;
      }
      const kind = value.includes('%') ? 'REG_EXPAND_SZ' : 'REG_SZ';
      callback(null, `\r\nHKEY\\${hive}\r\n    ${name}    ${kind}    ${value}\r\n\r\n`);
    },
  );
}

const USER = 'HKCU\\Environment';
const MACHINE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

const originalPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.resetModules();
  exec.execFile.mockReset();
  setPlatform('win32');
  for (const name of ['JAVA_HOME', 'ANDROID_HOME', 'DOTNET_ROOT', 'FLUTTER_ROOT']) {
    vi.stubEnv(name, '');
    delete process.env[name];
  }
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.unstubAllEnvs();
});

async function load() {
  return import('./windowsPath');
}

describe('refreshWindowsEnvVars', () => {
  it('picks up a variable an installer just set', async () => {
    registry({ [USER]: { JAVA_HOME: 'C:\\Java\\jdk-17' } });
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['JAVA_HOME']);

    expect(process.env.JAVA_HOME).toBe('C:\\Java\\jdk-17');
  });

  it("prefers the user's value over the machine's, as Windows does", async () => {
    registry({
      [USER]: { JAVA_HOME: 'C:\\User\\jdk' },
      [MACHINE]: { JAVA_HOME: 'C:\\Machine\\jdk' },
    });
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['JAVA_HOME']);

    expect(process.env.JAVA_HOME).toBe('C:\\User\\jdk');
  });

  it("falls back to the machine's value when the user has none", async () => {
    registry({ [MACHINE]: { DOTNET_ROOT: 'C:\\Program Files\\dotnet' } });
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['DOTNET_ROOT']);

    expect(process.env.DOTNET_ROOT).toBe('C:\\Program Files\\dotnet');
  });

  it('never replaces a variable the app already has', async () => {
    process.env.JAVA_HOME = 'C:\\Already\\here';
    registry({ [USER]: { JAVA_HOME: 'C:\\Java\\jdk-17' } });
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['JAVA_HOME']);

    expect(process.env.JAVA_HOME).toBe('C:\\Already\\here');
  });

  it('expands a value that refers to another variable', async () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\me');
    registry({ [USER]: { ANDROID_HOME: '%USERPROFILE%\\Android\\Sdk' } });
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['ANDROID_HOME']);

    expect(process.env.ANDROID_HOME).toBe('C:\\Users\\me\\Android\\Sdk');
  });

  it('leaves a variable alone when neither place has it', async () => {
    registry({});
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['FLUTTER_ROOT']);

    expect(process.env.FLUTTER_ROOT).toBeUndefined();
  });

  it('handles several at once, and one missing does not stop the others', async () => {
    registry({ [USER]: { JAVA_HOME: 'C:\\Java', FLUTTER_ROOT: 'C:\\flutter' } });
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['JAVA_HOME', 'ANDROID_HOME', 'FLUTTER_ROOT']);

    expect(process.env.JAVA_HOME).toBe('C:\\Java');
    expect(process.env.ANDROID_HOME).toBeUndefined();
    expect(process.env.FLUTTER_ROOT).toBe('C:\\flutter');
  });

  it('does not touch the registry off Windows', async () => {
    setPlatform('linux');
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['JAVA_HOME']);

    expect(exec.execFile).not.toHaveBeenCalled();
  });

  it('ignores a name that could not be a variable, since it ends up on a command line', async () => {
    registry({});
    const { refreshWindowsEnvVars } = await load();

    await refreshWindowsEnvVars(['JAVA_HOME /f /ve', 'a b', '']);

    expect(exec.execFile).not.toHaveBeenCalled();
  });
});

describe('refreshWindowsPath', () => {
  beforeEach(() => {
    vi.stubEnv('RUNOVA_E2E', '');
    vi.stubEnv('RUNOVA_E2E_HOME', '');
  });

  it('adds the folders the registry has and this process does not', async () => {
    vi.stubEnv('PATH', 'C:\Windows');
    registry({ [USER]: { Path: 'C:\Windows;C:\Tools\bin' } });
    const { refreshWindowsPath, pathKey } = await load();

    await refreshWindowsPath({ force: true });

    expect(process.env[pathKey(process.env)]).toBe('C:\Windows;C:\Tools\bin');
  });

  it('keeps the PATH an e2e run with a home of its own started with', async () => {
    // The website screenshots give the app a PATH of demo tools; reading the registry back
    // would bring this machine's real CLIs, and their paths, into the shots.
    vi.stubEnv('RUNOVA_E2E', '1');
    vi.stubEnv('RUNOVA_E2E_HOME', 'X:\northwind\home');
    vi.stubEnv('PATH', 'X:\northwind\bin');
    registry({ [USER]: { Path: 'C:\Tools\bin' } });
    const { refreshWindowsPath, pathKey } = await load();

    await refreshWindowsPath({ force: true });

    expect(process.env[pathKey(process.env)]).toBe('X:\northwind\bin');
    expect(exec.execFile).not.toHaveBeenCalled();
  });
});
