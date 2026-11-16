import { spawn } from 'node:child_process';
import type { RunnerCleanupFailure, RunnerMachineLink } from '../../../shared/apiTypes';
import { killProcessTree } from '../../process/spawnStreaming';
import type { SshLease } from '../../ssh/pool';
import { POSIX_RUNNER } from './posixScripts';
import { toBase64, toEncodedCommand } from './shellText';
import { WINDOWS_BOOTSTRAP, WINDOWS_RUNNER } from './windowsScripts';

/**
 * Runs a runner cleanup script on a runner's machine (E104): over the saved server's pooled SSH
 * connection, or on this computer. The caller builds the script once it knows which shell the
 * machine has, POSIX `sh` or Windows PowerShell.
 */

export type ShellKind = 'posix' | 'windows';

export interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface LocalRunInput {
  kind: ShellKind;
  script: string;
  timeoutMs: number;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface MachineShellDeps {
  platform: NodeJS.Platform;
  /** A test run of the app: the local machine is off limits. */
  isE2E: boolean;
  /** Throws when the saved server is gone. */
  findServer: (serverId: string) => Promise<unknown>;
  acquire: (serverId: string) => Promise<Pick<SshLease, 'connection' | 'release'>>;
  runLocal: (input: LocalRunInput) => Promise<ShellOutput>;
}

export interface RunOptions {
  timeoutMs: number;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export type MachineRun =
  | { ok: true; kind: ShellKind; output: ShellOutput }
  | { ok: false; reason: RunnerCleanupFailure; error: string };

const DETECT_TIMEOUT_MS = 15_000;
/** Scans of big work folders print a lot of size lines; this is far more than any will. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hands complete lines to `onLine` as chunks arrive. */
export function lineSplitter(onLine?: (line: string) => void): {
  push: (text: string) => void;
  end: () => void;
} {
  let rest = '';
  return {
    push(text) {
      if (!onLine) return;
      const parts = (rest + text).split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const part of parts) onLine(part);
    },
    end() {
      if (onLine && rest) onLine(rest);
      rest = '';
    },
  };
}

export function createMachineShell(deps: MachineShellDeps) {
  /** Which shell each server answered with, so the check is made once per server. */
  const kinds = new Map<string, ShellKind>();

  async function detect(lease: Pick<SshLease, 'connection'>): Promise<ShellKind> {
    const probe = await lease.connection.exec(`sh -c 'uname -s'`, { timeoutMs: DETECT_TIMEOUT_MS });
    return /^(Linux|Darwin)\b/.test(probe.stdout.trim()) ? 'posix' : 'windows';
  }

  async function runSsh(
    serverId: string,
    build: (kind: ShellKind) => string,
    options: RunOptions,
  ): Promise<MachineRun> {
    try {
      await deps.findServer(serverId);
    } catch {
      return { ok: false, reason: 'missing', error: 'This saved server no longer exists.' };
    }
    let lease: Pick<SshLease, 'connection' | 'release'>;
    try {
      lease = await deps.acquire(serverId);
    } catch (error) {
      const reason =
        (error as Error | null)?.name === 'VaultLockedError' ? 'locked' : 'unreachable';
      return { ok: false, reason, error: errorMessage(error) };
    }
    try {
      let kind = kinds.get(serverId);
      if (!kind) {
        kind = await detect(lease);
        kinds.set(serverId, kind);
      }
      const script = build(kind);
      const lines = lineSplitter(options.onLine);
      const result = await lease.connection.exec(kind === 'posix' ? POSIX_RUNNER : WINDOWS_RUNNER, {
        stdin: kind === 'posix' ? script : toBase64(script),
        timeoutMs: options.timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        onStdout: lines.push,
      });
      lines.end();
      if (result.timedOut) {
        return { ok: false, reason: 'unreachable', error: 'The machine took too long to answer.' };
      }
      return {
        ok: true,
        kind,
        output: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: false,
        },
      };
    } catch (error) {
      return { ok: false, reason: 'unreachable', error: errorMessage(error) };
    } finally {
      lease.release();
    }
  }

  async function runLocal(
    build: (kind: ShellKind) => string,
    options: RunOptions,
  ): Promise<MachineRun> {
    if (deps.isE2E) {
      return {
        ok: false,
        reason: 'off',
        error: 'Runner cleanup does not touch this computer during a test run.',
      };
    }
    const kind: ShellKind = deps.platform === 'win32' ? 'windows' : 'posix';
    try {
      const output = await deps.runLocal({
        kind,
        script: build(kind),
        timeoutMs: options.timeoutMs,
        onLine: options.onLine,
        signal: options.signal,
      });
      if (output.timedOut) {
        return {
          ok: false,
          reason: 'unreachable',
          error: 'This computer took too long to answer.',
        };
      }
      return { ok: true, kind, output };
    } catch (error) {
      return { ok: false, reason: 'unreachable', error: errorMessage(error) };
    }
  }

  return {
    run(
      link: RunnerMachineLink,
      build: (kind: ShellKind) => string,
      options: RunOptions,
    ): Promise<MachineRun> {
      return link.kind === 'local'
        ? runLocal(build, options)
        : runSsh(link.serverId, build, options);
    },
  };
}

/**
 * Runs a script on this computer with the same runners the SSH side uses: `sh` reading the whole
 * script from stdin, or PowerShell reading it as base64 from stdin.
 */
export function runLocalScript(
  input: LocalRunInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShellOutput> {
  const [command, args, stdin] =
    input.kind === 'posix'
      ? ['/bin/sh', ['-c', 'S=$(cat); eval "$S"'], input.script]
      : [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            toEncodedCommand(WINDOWS_BOOTSTRAP),
          ],
          toBase64(input.script),
        ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const lines = lineSplitter(input.onLine);
    const stop = (): void => killProcessTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    input.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
      lines.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', stop);
      lines.end();
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
    child.stdin.on('error', () => {
      // The script may exit before reading everything; its output says what happened.
    });
    child.stdin.end(stdin);
  });
}
