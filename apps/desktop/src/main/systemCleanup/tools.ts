import type { CommandAction } from '@runova/core';
import { resolveExecutable } from '../installMethod';
import { type CancelToken, cancelSpawn, spawnStreaming } from '../process/spawnStreaming';
import type { CommandOutcome } from './engine/cleaner';

/**
 * Running the few tools Disk Cleanup talks to: asking one where its cache is, and running the
 * command that cleans a cache only its tool understands. Both go through the shared streaming
 * spawner, which already deals with Windows shims and quoting, the PATH of tools pip installed,
 * timeouts and killing a whole process tree.
 */

/** Long enough for a cold `dotnet` or `npm`, short enough that the page is not left waiting. */
const QUERY_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 3 * 60_000;
/** A long command is given this long without printing anything before it counts as stuck. */
const LONG_COMMAND_TIMEOUT_MS = 20 * 60_000;

export interface ToolRunnerOptions {
  /** Where commands run. Never a project folder, so nothing picks up a project's own settings. */
  home: string;
  baseEnv: NodeJS.ProcessEnv;
  queryTimeoutMs?: number;
}

export interface ToolRunner {
  /** What a tool printed when asked a question, or null if it failed or took too long. */
  query(command: string, args: string[]): Promise<string | null>;
  runCommand(
    action: CommandAction,
    onLine: (line: string) => void,
    signal: AbortSignal | undefined,
  ): Promise<CommandOutcome>;
}

export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const env: NodeJS.ProcessEnv = {
    ...options.baseEnv,
    // Asking dotnet something should not print its welcome text or send anything to Microsoft.
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    NO_COLOR: '1',
  };

  return {
    async query(command, args) {
      const token: CancelToken = { cancelled: false, child: null };
      const result = await spawnStreaming({
        command,
        args,
        cwd: options.home,
        env,
        timeoutMs: options.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
        token,
      });
      return result.code === 0 && !result.timedOut ? result.log : null;
    },

    async runCommand(action, onLine, signal) {
      const token: CancelToken = { cancelled: false, child: null };
      const stop = (): void => cancelSpawn(token);
      if (signal?.aborted) stop();
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const result = await spawnStreaming({
          command: action.command,
          args: action.args,
          cwd: options.home,
          env,
          timeoutMs: action.long ? LONG_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
          idle: true,
          token,
          onLine: (line) => {
            if (line.trim() !== '') onLine(line);
          },
        });
        return {
          code: result.code,
          cancelled: result.cancelled,
          notFound: result.notFound,
          timedOut: result.timedOut,
        };
      } finally {
        signal?.removeEventListener('abort', stop);
      }
    },
  };
}

/** Which of these commands are installed, found the way the shell would and without running any. */
export async function findTools(commands: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const command of new Set(commands)) {
    if (await resolveExecutable([command])) found.add(command);
  }
  return found;
}
