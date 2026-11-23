import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findExecutable, isExecutableFile } from '../devSetup/probe';
import { pathKey } from '../windowsPath';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 20000;

/**
 * Every `gh` call is its own process with its own TLS handshake. On a flaky link
 * (a VPN or proxy tunnel, most often) some of those handshakes never finish, and
 * gh gives up after Go's fixed 10 seconds with "TLS handshake timeout". A browser
 * rarely shows this because it keeps one good connection open and reuses it.
 * A stuck handshake doesn't get better with waiting, but a fresh one usually goes
 * straight through, so these calls are retried quickly. They are also queued,
 * since a page firing a few dozen at once (a repo's workflow files, every project
 * on the dashboard) makes the stalls a lot more common.
 */
const GH_MAX_CONCURRENT = 4;
const GH_RETRY_DELAYS_MS = [500, 1500, 3000];

/**
 * Failures from before the request left the machine, so a retry can't send anything
 * twice, even for a POST.
 */
const GH_PRE_SEND_FAILURE = /TLS handshake timeout|dial tcp|proxyconnect|connectex/i;
/** Failures that may have happened after the request went out, only retried for reads. */
const GH_MID_REQUEST_FAILURE =
  /unexpected EOF|connection reset|forcibly closed|Client\.Timeout|i\/o timeout|HTTP 50[234]/i;
/** `gh api` flags that turn a call into a write (a field alone makes it a POST). */
const GH_API_WRITE_FLAGS = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '--input',
]);

function isRetryableGhFailure(error: unknown, readOnly: boolean): boolean {
  const message = ghErrorMessage(error);
  if (GH_PRE_SEND_FAILURE.test(message)) return true;
  if (!readOnly) return false;
  // Our own timeout killed it, which on a stalled connection means a hung download.
  if ((error as { killed?: boolean }).killed) return true;
  return GH_MID_REQUEST_FAILURE.test(message);
}

let ghActive = 0;
const ghWaiting: (() => void)[] = [];

async function acquireGhSlot(): Promise<void> {
  if (ghActive < GH_MAX_CONCURRENT) {
    ghActive += 1;
    return;
  }
  await new Promise<void>((resolve) => ghWaiting.push(resolve));
}

function releaseGhSlot(): void {
  const next = ghWaiting.shift();
  // The slot passes straight to the next caller, so the count stays as it is.
  if (next) next();
  else ghActive -= 1;
}

let ghLookup: { path: string; found: string } | null = null;

/**
 * The command to start gh with. On Windows, a spawn without a shell looks in the child's working
 * directory before PATH (and only the app's own environment can turn that off), and gh runs with
 * cwd set to a project folder, so a repository that commits gh.exe would run instead. There gh is
 * started by its full path on PATH, and not at all when there is none.
 */
async function ghCommand(): Promise<string> {
  if (process.platform !== 'win32') return 'gh';
  const path = process.env[pathKey(process.env)] ?? '';
  if (ghLookup?.path === path) return ghLookup.found;
  // gh ships as gh.exe; execFile could not start a .cmd or .bat anyway.
  const found = await findExecutable('gh', {
    env: { ...process.env, PATHEXT: '.EXE' },
    os: 'win32',
    exists: isExecutableFile,
  });
  if (!found) {
    throw Object.assign(new Error('spawn gh ENOENT: the GitHub CLI is not on PATH'), {
      code: 'ENOENT',
    });
  }
  ghLookup = { path, found };
  return found;
}

export interface RunGhOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  /** Set for commands that only read, so a connection lost mid-request can be retried too. */
  readOnly?: boolean;
}

/**
 * Runs one `gh` command through the shared queue, retrying when the connection
 * dropped before the request was sent (or at any point, for reads). Throws the last
 * failure, stderr included.
 */
export async function runGh(
  args: string[],
  options: RunGhOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  for (let attempt = 0; ; attempt += 1) {
    await acquireGhSlot();
    try {
      return await execFileAsync(await ghCommand(), args, {
        cwd: options.cwd,
        timeout: options.timeout ?? GH_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        windowsHide: true,
        // Read at call time: the proxy settings rewrite these variables while the app runs.
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (error) {
      const delay = GH_RETRY_DELAYS_MS[attempt];
      if (delay == null || !isRetryableGhFailure(error, options.readOnly ?? false)) throw error;
    } finally {
      releaseGhSlot();
    }
    // Waiting outside the slot, so a retry doesn't hold up calls that are fine.
    await new Promise((resolve) => setTimeout(resolve, GH_RETRY_DELAYS_MS[attempt]));
  }
}

export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const match = url.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export async function isGhCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync(await ghCommand(), ['--version'], { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function ghErrorMessage(error: unknown): string {
  const err = error as { stderr?: string; message?: string };
  return (err.stderr || err.message || 'The GitHub CLI command failed.').trim();
}

/** One `gh api` call, parsed. Throws with gh's own stderr, which is usually the clearest message. */
export async function ghApi<T>(path: string, args: string[] = []): Promise<T> {
  const { stdout } = await runGh(
    ['api', '-H', 'Accept: application/vnd.github+json', path, ...args],
    { readOnly: !args.some((arg) => GH_API_WRITE_FLAGS.has(arg)) },
  );
  return JSON.parse(stdout) as T;
}

/**
 * Same as `ghApi`, but GitHub's mark-as-read endpoints return 205 with an empty
 * body, which is success rather than invalid JSON.
 */
export async function ghApiAllowEmpty(path: string, args: string[] = []): Promise<void> {
  const { stdout } = await runGh([
    'api',
    '-H',
    'Accept: application/vnd.github+json',
    path,
    ...args,
  ]);
  const trimmed = stdout.trim();
  if (!trimmed) return;
  JSON.parse(trimmed);
}

interface GithubGraphqlPayload<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * One `gh api graphql` call. Throws when GitHub returns errors in the payload. Strings go in as
 * `-f` (raw), so user text such as a comment starting with "@" is never read as a file path;
 * only numbers and booleans use the typed `-F`.
 */
export async function ghGraphql<T>(
  query: string,
  variables: Record<string, string | number | boolean> = {},
): Promise<T> {
  const args = ['-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === 'string' ? '-f' : '-F', `${name}=${value}`);
  }
  const payload = await ghApi<GithubGraphqlPayload<T>>('graphql', args);
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  if (!payload.data) throw new Error('GitHub GraphQL returned no data.');
  return payload.data;
}
