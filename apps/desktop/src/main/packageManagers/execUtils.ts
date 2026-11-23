import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CliResult {
  stdout: string;
  stderr: string;
  /** 0 on a clean exit; non-zero exits are returned, not thrown, since package
   *  managers like `npm outdated` use exit code 1 to mean "found results". */
  code: number;
}

interface ExecErrorLike extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

const NOT_FOUND_PATTERN =
  /is not recognized as an internal or external command|command not found|no such file or directory/i;

/** Thrown when the underlying CLI (npm/yarn/pnpm/dotnet) isn't on PATH at all. */
export class CliNotFoundError extends Error {}

/**
 * Wraps one argument for `cmd.exe /s /c`. Inside double quotes cmd stops treating
 * `&`, `|`, `<`, `>` and `^` as syntax, so quoting every argument is what keeps a
 * package name or a folder called `a & b` from being read as a second command.
 * A run of trailing backslashes is doubled so a path ending in one doesn't escape
 * the closing quote.
 *
 * A literal double quote is refused rather than escaped: cmd has no escape for it
 * that survives this form, and nothing here can legitimately contain one (Windows
 * paths can't hold a quote, and package names and versions are validated upstream).
 */
function quoteForCmd(value: string): string {
  if (value.includes('"')) {
    throw new Error(`Refusing to run a command with a quote in an argument: ${value}`);
  }
  return `"${value.replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * Extra environment for read-only listing commands (`yarn outdated`, `pnpm outdated`) that run
 * inside a project folder the user may have just cloned. Each one stops the repository from
 * picking which package manager binary actually runs, or from loading its own code into it:
 * - YARN_IGNORE_PATH ignores a `yarnPath` in .yarnrc / .yarnrc.yml, which points at a JS file
 *   committed to the repo.
 * - YARN_RC_FILENAME points Yarn 2+ at an rc file that does not exist, so the repo's
 *   .yarnrc.yml cannot load `plugins` (also committed JS). Yarn 2+ has no `outdated` command,
 *   so listing loses nothing; Yarn 1 does not read this variable.
 * - PNPM_CONFIG_PM_ON_FAIL=ignore (pnpm 11+) and npm_config_manage_package_manager_versions=false
 *   (pnpm 9.7 to 10) keep pnpm from downloading and running the version pinned in package.json.
 * - COREPACK_ENABLE_PROJECT_SPEC=0 makes a Corepack shim run the system-wide manager instead of
 *   the one named by the project's `packageManager` field, and COREPACK_ENABLE_STRICT=0 keeps it
 *   from refusing to run when the two differ.
 */
export const LISTING_ENV: Readonly<Record<string, string>> = Object.freeze({
  YARN_IGNORE_PATH: '1',
  YARN_RC_FILENAME: '.runova-ignores-project-yarnrc.yml',
  PNPM_CONFIG_PM_ON_FAIL: 'ignore',
  npm_config_manage_package_manager_versions: 'false',
  COREPACK_ENABLE_PROJECT_SPEC: '0',
  COREPACK_ENABLE_STRICT: '0',
});

/**
 * Runs a CLI command, routing through cmd.exe on Windows so npm/yarn/pnpm/dotnet
 * .cmd shims spawn correctly (Node refuses to spawn .cmd files directly as of
 * Node >=18.20/20.11/21.6). Arguments carry parsed manifest data and, for
 * updates, a package name and version that started life in the renderer, so on
 * Windows the whole command line is quoted by hand and handed to cmd verbatim
 * rather than left to Node, which only quotes arguments containing whitespace.
 *
 * Non-zero exits are returned rather than thrown. Outdated-package commands
 * commonly exit 1 when they find results, which is expected, not a failure.
 * A genuinely missing CLI (ENOENT, or cmd.exe's "not recognized") throws
 * CliNotFoundError so callers can render a cli-missing state.
 *
 * `extraEnv` is laid over the inherited environment, for example LISTING_ENV.
 */
export async function runCli(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  const options = {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    // Cline's CLI self-updates on every invocation, including a bare version check,
    // by spawning a detached background installer; on Windows that can flash open a
    // visible console. This is a no-op env var for every other CLI we shell out to.
    // cmd.exe looks for a command in the current directory before PATH, and cwd is the
    // project folder, so a repo shipping its own npm.cmd or dotnet.bat would run that instead.
    // This variable turns the current-directory lookup off (for the shims' own nested cmd too).
    env: {
      ...process.env,
      CLINE_NO_AUTO_UPDATE: '1',
      NoDefaultCurrentDirectoryInExePath: '1',
      ...extraEnv,
    },
  };
  try {
    // The command name stays unquoted: npm/yarn/pnpm are .cmd shims that work out
    // their own install directory from %~dp0, and that only resolves correctly when
    // cmd found the name on PATH itself. These names are code-authored constants.
    const commandLine = `"${[command, ...args.map(quoteForCmd)].join(' ')}"`;
    const { stdout, stderr } =
      process.platform === 'win32'
        ? await execFileAsync('cmd.exe', ['/d', '/s', '/c', commandLine], {
            ...options,
            // Node must not re-quote what is already a finished command line.
            windowsVerbatimArguments: true,
          })
        : await execFileAsync(command, args, options);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as ExecErrorLike;
    if (e.code === 'ENOENT' || e.code === 9009 || NOT_FOUND_PATTERN.test(e.stderr ?? '')) {
      throw new CliNotFoundError(`${command} is not available on PATH`);
    }
    if (typeof e.stdout === 'string' || typeof e.stderr === 'string') {
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
    throw err;
  }
}

export function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Runs async tasks with a concurrency cap, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
