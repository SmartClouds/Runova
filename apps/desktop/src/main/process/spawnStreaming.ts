import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { withToolPath } from '../toolPaths';

/**
 * Long running child processes the user watches and can stop: security scans and test runs.
 *
 * They differ from the app's other child processes in three ways that make the buffered helpers a
 * poor fit: they run for minutes rather than seconds, their output is shown as it arrives, and they
 * have to be cancellable partway through. So this streams line by line rather than buffering to
 * completion, and keeps only a capped tail of output rather than the whole log, since a CodeQL
 * extractor or a big test suite can emit hundreds of megabytes.
 */

const MAX_LOG_CHARS = 20_000;
/** How long a POSIX child gets to act on SIGTERM before the group is killed outright. */
const SIGKILL_AFTER_MS = 5_000;

/** Color and cursor codes are noise once the output is shown in a log panel. */
export function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is what an ANSI escape sequence starts with, matching it is the point
      .replace(/\u001B\[[?]?\d*(?:;\d+)*[a-zA-Z]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences are delimited by BEL/ESC
      .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
      .replace(/\[(?:\d{1,3};)*\d{1,3}m/g, '')
      .replace(/\r/g, '')
  );
}

export function trimLog(log: string): string {
  if (log.length <= MAX_LOG_CHARS) return log;
  return `... (earlier output trimmed)\n${log.slice(-MAX_LOG_CHARS)}`;
}

/**
 * Wraps one argument for `cmd.exe /s /c`. Same rules as the copy in packageManagers/execUtils:
 * inside double quotes cmd stops treating `&`, `|`, `<`, `>` and `^` as syntax, and a run of
 * trailing backslashes is doubled so a path ending in one cannot escape the closing quote. That
 * last part is what keeps `--source-root=E:\proj\` working.
 *
 * A literal double quote is refused rather than escaped, because cmd has no escape for it that
 * survives this form and no Windows path can contain one anyway.
 */
export function quoteForCmd(value: string): string {
  if (value.includes('"')) {
    throw new Error(`Refusing to run a command with a quote in an argument: ${value}`);
  }
  return `"${value.replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * Windows spawns tools under cmd.exe, and the tools themselves spawn more processes: Semgrep
 * starts Python workers, CodeQL starts a JVM, a test runner starts workers and browsers. Killing
 * only the direct child would leave every one of those running, so the whole tree goes down.
 */
export function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      // Best effort: the process may already have exited on its own.
    });
    return;
  }
  if (!child.pid) return;
  // The child leads its own process group (it is spawned detached), so a negative pid signals the
  // whole group. Signalling the child alone would leave its own children running.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // No group, or it is already gone: the direct child is all there is to stop.
    try {
      child.kill('SIGTERM');
    } catch {
      // Already exited.
    }
  }
  const pid = child.pid;
  const escalate = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Gone after all.
    }
  }, SIGKILL_AFTER_MS);
  escalate.unref?.();
}

export interface CancelToken {
  cancelled: boolean;
  /** Set by the spawn so a cancel mid-run can reach the live child. */
  child: ChildProcess | null;
}

export function cancelSpawn(token: CancelToken): void {
  token.cancelled = true;
  if (token.child) killProcessTree(token.child);
}

export interface SpawnStreamingOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** How long the command may run in all, or with `idle`, how long it may go without output. */
  timeoutMs: number;
  /**
   * Counts `timeoutMs` from the last output instead of from the start. A long run that keeps
   * printing is working, and only one that has gone quiet is stuck.
   */
  idle?: boolean;
  token: CancelToken;
  /** Called for each output line with ANSI codes and carriage returns removed, indentation kept. */
  onLine?: (line: string) => void;
}

export interface SpawnStreamingResult {
  code: number | null;
  log: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the binary itself could not be found, which is a different problem from a bad run. */
  notFound: boolean;
}

const NOT_FOUND = /is not recognized as an internal or external command|command not found|ENOENT/i;

/**
 * Runs one command to completion, streaming its output.
 *
 * The timeout is enforced with our own timer plus a tree kill rather than with the `timeout`
 * option, because on Windows that option signals cmd.exe and orphans the real process, which is
 * exactly the failure this needs to avoid for a 45-minute CodeQL run.
 */
export async function spawnStreaming(
  options: SpawnStreamingOptions,
): Promise<SpawnStreamingResult> {
  // Tools installed by pip live in a Scripts folder that is off PATH on Windows, and Semgrep in
  // particular re-execs `pysemgrep` by name, so the folder has to be on the child's PATH and not
  // merely resolved into an absolute command.
  // cwd is often a project folder (a scanned repository, say), and cmd.exe looks in the current
  // directory before PATH, so a repository that commits semgrep.cmd would run in place of the
  // real tool. This turns that lookup off; a caller that means a file in cwd names its path.
  const env = {
    ...(await withToolPath(options.env)),
    NoDefaultCurrentDirectoryInExePath: '1',
  };
  // A cancel that lands while PATH is being resolved has no child to kill yet, so honour it here
  // rather than starting something nobody is waiting for.
  if (options.token.cancelled) {
    return { code: null, log: '', timedOut: false, cancelled: true, notFound: false };
  }
  const onWindows = process.platform === 'win32';
  // Route through cmd.exe on Windows so .cmd/.bat shims (trivy via winget, node_modules/.bin,
  // gradlew.bat) spawn at all. Every part of this matters: the command name stays unquoted so a
  // .cmd shim can resolve its own install directory from %~dp0, each argument is quoted so a path
  // with a space or an ampersand in it survives, and the whole line takes one outer pair of quotes
  // because `cmd /s` strips the first and last quote of whatever follows /c. Built before the
  // promise so a refused argument rejects instead of starting a half-quoted command.
  const commandLine = onWindows
    ? `"${[options.command, ...options.args.map(quoteForCmd)].join(' ')}"`
    : '';

  return new Promise((resolve) => {
    const child = onWindows
      ? spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
          cwd: options.cwd,
          env,
          windowsHide: true,
          // Node must not re-quote what is already a finished command line.
          windowsVerbatimArguments: true,
        })
      : spawn(options.command, options.args, {
          cwd: options.cwd,
          env,
          // Its own process group, so cancelling can take down the tools it starts in turn
          // (a test runner's workers, a scanner's Python helpers) and not just the child itself.
          detached: true,
        });

    options.token.child = child;

    let log = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);

    /**
     * stdout and stderr are separate pipes and interleave freely, so each keeps its own half-read
     * line. Sharing one buffer glues a stderr line onto whatever stdout had not finished writing.
     */
    const reader = () => {
      let pending = '';
      return {
        push(chunk: Buffer | string): void {
          const text = stripAnsi(chunk.toString());
          log = trimLog(log + text);
          if (!options.onLine) return;
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) options.onLine(line);
        },
        rest: (): string => pending,
      };
    };
    const out = reader();
    const err = reader();

    // refresh() restarts the same timer, so a chatty run does not allocate one per chunk.
    const heard = (): void => {
      if (options.idle) timer.refresh();
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      heard();
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      heard();
      err.push(chunk);
    });

    const finish = (code: number | null, notFound: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.token.child = null;
      for (const rest of [out.rest(), err.rest()]) {
        if (rest && options.onLine) options.onLine(rest);
      }
      resolve({
        code,
        log,
        timedOut,
        cancelled: options.token.cancelled,
        notFound: notFound || NOT_FOUND.test(log),
      });
    };

    child.on('error', (error) => {
      log = trimLog(log + String(error));
      finish(null, NOT_FOUND.test(String(error)));
    });
    child.on('close', (code) => finish(code, false));
  });
}
