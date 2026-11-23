import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../../test/main/fixtures';
import {
  CliNotFoundError,
  LISTING_ENV,
  mapWithConcurrency,
  runCli,
  tryParseJson,
} from './execUtils';

/**
 * runCli is the only place the app shells out to a package manager, so the shape of the command
 * line it builds is security-relevant: a project folder or a package name that reaches cmd.exe
 * unquoted turns `&` into a command separator.
 */

interface ExecCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

interface ExecOutcome {
  stdout?: string;
  stderr?: string;
  /** Set to reject: node reports a failed spawn as an error carrying the captured output. */
  error?: { message: string; code?: string | number; stdout?: string; stderr?: string };
}

const execState = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  outcomes: [] as ExecOutcome[],
}));

/**
 * The real execFile carries a `util.promisify.custom` implementation that resolves to
 * `{ stdout, stderr }`. Without it promisify would resolve to stdout alone and the module under
 * test would silently destructure undefined, so the stand-in has to provide the same symbol.
 */
vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(() => undefined, {
    [custom]: (file: string, args: string[], options: Record<string, unknown>) => {
      execState.calls.push({ file, args, options });
      const outcome = execState.outcomes.shift() ?? {};
      if (outcome.error) {
        return Promise.reject(Object.assign(new Error(outcome.error.message), outcome.error));
      }
      return Promise.resolve({ stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
    },
  });
  return { execFile };
});

beforeEach(() => {
  execState.calls = [];
  execState.outcomes = [];
});

describe('runCli on POSIX', () => {
  it('spawns the command directly with the arguments untouched', async () => {
    execState.outcomes.push({ stdout: 'ok\n' });

    const result = await withPlatform('linux', () =>
      runCli('npm', ['outdated', '--json'], '/home/me/app'),
    );

    expect(result).toEqual({ stdout: 'ok\n', stderr: '', code: 0 });
    expect(execState.calls).toHaveLength(1);
    expect(execState.calls[0].file).toBe('npm');
    expect(execState.calls[0].args).toEqual(['outdated', '--json']);
  });

  it('passes the cwd, timeout and a buffer big enough for a large JSON report', async () => {
    execState.outcomes.push({ stdout: '{}' });

    await withPlatform('darwin', () => runCli('pnpm', ['outdated'], '/repo', 1234));

    const { options } = execState.calls[0];
    expect(options.cwd).toBe('/repo');
    expect(options.timeout).toBe(1234);
    expect(options.windowsHide).toBe(true);
    expect(options.maxBuffer).toBe(10 * 1024 * 1024);
    // Cline's CLI self-updates on every invocation unless this is set.
    expect((options.env as Record<string, string>).CLINE_NO_AUTO_UPDATE).toBe('1');
    // The rest of the environment has to survive, or PATH lookups break.
    expect(
      (options.env as Record<string, string>).PATH ?? (options.env as Record<string, string>).Path,
    ).toBeDefined();
  });

  it('defaults the timeout to 30 seconds', async () => {
    execState.outcomes.push({ stdout: '' });
    await withPlatform('linux', () => runCli('npm', [], '/repo'));
    expect(execState.calls[0].options.timeout).toBe(30000);
  });

  it('lays extra environment over the inherited one', async () => {
    execState.outcomes.push({ stdout: '' });
    await withPlatform('linux', () =>
      runCli('yarn', ['outdated'], '/repo', undefined, LISTING_ENV),
    );
    const env = execState.calls[0].options.env as Record<string, string>;
    expect(env).toMatchObject({
      CLINE_NO_AUTO_UPDATE: '1',
      YARN_IGNORE_PATH: '1',
      YARN_RC_FILENAME: '.runova-ignores-project-yarnrc.yml',
      PNPM_CONFIG_PM_ON_FAIL: 'ignore',
      npm_config_manage_package_manager_versions: 'false',
      COREPACK_ENABLE_PROJECT_SPEC: '0',
    });
    expect(env.PATH ?? env.Path).toBeDefined();
  });
});

describe('runCli on Windows', () => {
  it('routes through cmd.exe so the .cmd shims can be spawned at all', async () => {
    execState.outcomes.push({ stdout: '{}' });

    await withPlatform('win32', () => runCli('npm', ['outdated', '--json'], 'C:\\repo'));

    expect(execState.calls[0].file).toBe('cmd.exe');
    expect(execState.calls[0].args).toEqual(['/d', '/s', '/c', '"npm "outdated" "--json""']);
    // Node must not re-quote a command line that is already finished.
    expect(execState.calls[0].options.windowsVerbatimArguments).toBe(true);
  });

  it('quotes an argument holding cmd syntax so it cannot start a second command', async () => {
    execState.outcomes.push({ stdout: '' });

    await withPlatform('win32', () =>
      runCli('npm', ['install', 'left-pad@1.0.0 & calc.exe'], 'C:\\repo'),
    );

    const commandLine = execState.calls[0].args[3];
    expect(commandLine).toBe('"npm "install" "left-pad@1.0.0 & calc.exe""');
  });

  it('doubles a run of trailing backslashes so a path cannot escape its closing quote', async () => {
    execState.outcomes.push({ stdout: '' });

    await withPlatform('win32', () => runCli('dotnet', ['add', 'C:\\proj\\'], 'C:\\proj'));

    // Without the doubling, cmd would read the closing quote as escaped and swallow the rest.
    expect(execState.calls[0].args[3]).toBe('"dotnet "add" "C:\\proj\\\\""');
  });

  it('refuses an argument containing a double quote rather than trying to escape it', async () => {
    await expect(
      withPlatform('win32', () => runCli('npm', ['install', 'a"b'], 'C:\\repo')),
    ).rejects.toThrow(/Refusing to run a command with a quote/);
    expect(execState.calls).toEqual([]);
  });

  it('leaves the command name unquoted so the .cmd shim can resolve %~dp0', async () => {
    execState.outcomes.push({ stdout: '' });

    await withPlatform('win32', () => runCli('yarn', ['outdated'], 'C:\\repo'));

    expect(execState.calls[0].args[3].startsWith('"yarn "')).toBe(true);
  });

  it('stops cmd.exe from running a same-named script out of the project folder', async () => {
    execState.outcomes.push({ stdout: '' });

    await withPlatform('win32', () => runCli('npm', ['outdated'], 'C:\\cloned-repo'));

    // Without it, a repo's own npm.cmd next to its package.json would run instead of npm.
    const env = execState.calls[0].options.env as Record<string, string>;
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });
});

describe('runCli failures', () => {
  it('returns a non-zero exit instead of throwing, since `npm outdated` exits 1 on results', async () => {
    execState.outcomes.push({
      error: { message: 'Command failed', code: 1, stdout: '{"left-pad":{}}', stderr: '' },
    });

    const result = await withPlatform('linux', () => runCli('npm', ['outdated'], '/repo'));

    expect(result).toEqual({ stdout: '{"left-pad":{}}', stderr: '', code: 1 });
  });

  it('keeps stderr and falls back to code 1 when the exit code is not numeric', async () => {
    execState.outcomes.push({
      error: { message: 'boom', code: 'ETIMEDOUT', stdout: '', stderr: 'timed out' },
    });

    const result = await withPlatform('linux', () => runCli('npm', ['install'], '/repo'));

    expect(result).toEqual({ stdout: '', stderr: 'timed out', code: 1 });
  });

  it('throws CliNotFoundError on ENOENT so callers can show a cli-missing state', async () => {
    execState.outcomes.push({ error: { message: 'spawn npm ENOENT', code: 'ENOENT' } });

    await expect(withPlatform('linux', () => runCli('npm', [], '/repo'))).rejects.toBeInstanceOf(
      CliNotFoundError,
    );
  });

  it('throws CliNotFoundError on cmd.exe exit code 9009', async () => {
    execState.outcomes.push({ error: { message: 'failed', code: 9009 } });

    await expect(withPlatform('win32', () => runCli('pnpm', [], 'C:\\repo'))).rejects.toThrow(
      /pnpm is not available on PATH/,
    );
  });

  it.each([
    "'dotnet' is not recognized as an internal or external command",
    'bash: flutter: command not found',
    'env: dart: No such file or directory',
  ])('recognizes %j as a missing CLI', async (stderr) => {
    execState.outcomes.push({ error: { message: 'failed', code: 1, stdout: '', stderr } });

    await expect(withPlatform('linux', () => runCli('dart', [], '/repo'))).rejects.toBeInstanceOf(
      CliNotFoundError,
    );
  });

  it('rethrows an error that carries no captured output at all', async () => {
    execState.outcomes.push({ error: { message: 'something else entirely' } });

    await expect(withPlatform('linux', () => runCli('npm', [], '/repo'))).rejects.toThrow(
      'something else entirely',
    );
  });
});

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null rather than throwing on CLI noise mixed into stdout', () => {
    expect(tryParseJson('npm warn config\n{"a":1}')).toBeNull();
    expect(tryParseJson('')).toBeNull();
  });
});

describe('mapWithConcurrency', () => {
  it('keeps the input order in the results even when tasks finish out of order', async () => {
    const result = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return `v${ms}`;
    });

    expect(result).toEqual(['v30', 'v10', 'v20']);
  });

  it('never runs more than the cap at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n % 3));
      inFlight--;
      return n;
    });

    // The cap exists because each dotnet task spawns two MSBuild processes.
    expect(peak).toBe(3);
  });

  it('handles an empty list without starting a worker', async () => {
    let ran = 0;
    const result = await mapWithConcurrency<number, number>([], 5, async (n) => {
      ran++;
      return n;
    });
    expect(result).toEqual([]);
    expect(ran).toBe(0);
  });

  it('caps at the item count when the limit is larger', async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);
    expect(result).toEqual([2, 4]);
  });
});
