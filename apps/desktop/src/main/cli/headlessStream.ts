import { spawn } from 'node:child_process';
import { stripAnsi } from '../process/spawnStreaming';
import {
  type HeadlessOutcome,
  type HeadlessPromptOptions,
  type HeadlessPromptResult,
  headlessResult,
  killProcessTree,
  prepareHeadlessRun,
  stripEnvExpansions,
  truncateForCommandLine,
} from './headlessPrompt';
import { type ProgressDecoder, progressDecoderFor } from './progressFormat';

/**
 * A headless CLI run the user watches: its output arrives line by line while it works, and it can
 * be stopped through an AbortSignal. It starts the CLI exactly as runHeadlessCliPrompt does (same
 * CLI resolution, same arguments) but keeps the answer (stdout) apart from the progress, which is
 * what Studio needs to read the JSON it asked for.
 */

/** An answer is a document, never a dump; anything past this is cut off. */
const MAX_ANSWER_CHARS = 10 * 1024 * 1024;

export interface StreamPromptOptions
  extends Omit<HeadlessPromptOptions, 'requestId' | 'timeoutMs' | 'images'> {
  signal: AbortSignal;
  /** Each line the CLI prints, on either stream, with color codes removed. */
  onLine: (line: string) => void;
  timeoutMs: number;
  /**
   * Sent instead of the prompt to a CLI that takes it as an argument, pointing it at a file in
   * `cwd` that holds the whole prompt. Without it the prompt is cut to fit the Windows command line.
   */
  pointerPrompt?: string;
  /**
   * Someone is watching `onLine`, so a CLI that only prints at the end is asked to report each
   * step as it goes, and those steps are turned into readable lines. The answer is still the
   * same text a plain run gives back.
   */
  readableProgress?: boolean;
}

export async function streamHeadlessCliPrompt(
  prompt: string,
  cwd: string,
  options: StreamPromptOptions,
): Promise<HeadlessPromptResult> {
  const cancelled = (cliName: string | null): HeadlessPromptResult => ({
    ok: false,
    text: '',
    cliName,
    cancelled: true,
    error: 'Request cancelled.',
  });
  if (options.signal.aborted) return cancelled(null);
  const prepared = await prepareHeadlessRun(prompt, cwd, options);
  if (!prepared.ok) return prepared.result;
  const { cli, command, args, prompt: fullPrompt, env } = prepared.run;
  if (options.signal.aborted) return cancelled(cli.name);

  const decoder = options.readableProgress ? progressDecoderFor(cli, cwd) : null;
  const runArgs = decoder ? [...args, ...(cli.promptProgressArgs ?? [])] : args;
  const viaStdin = cli.promptInputMode === 'stdin';
  const argv = viaStdin
    ? runArgs
    : [
        ...runArgs,
        options.pointerPrompt ??
          truncateForCommandLine(stripEnvExpansions(fullPrompt), command, args),
      ];
  const outcome = await spawnPrompt(
    command,
    argv,
    cwd,
    env,
    viaStdin ? fullPrompt : null,
    options,
    decoder,
  );
  return headlessResult(cli.name, outcome, options.timeoutMs);
}

function spawnPrompt(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdinPayload: string | null,
  options: StreamPromptOptions,
  decoder: ProgressDecoder | null,
): Promise<HeadlessOutcome> {
  return new Promise((resolve) => {
    // The same argv form execFile gets in runHeadlessCliPrompt: npm-installed CLIs are .cmd shims
    // on Windows, which only cmd.exe can start.
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', command, ...args], { cwd, env, windowsHide: true })
        : spawn(command, args, { cwd, env });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    /** The decoded steps, kept as the run's log since stdout no longer carries plain text. */
    const steps: string[] = [];

    /** Each stream keeps its own half-read line, so the two never glue together. */
    const lineReader = (decode?: (line: string) => string[]) => {
      let pending = '';
      return {
        push(text: string) {
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) take(line);
        },
        end() {
          if (pending) take(pending);
          pending = '';
        },
      };
      function take(line: string) {
        if (!decode) {
          emit(line);
          return;
        }
        for (const step of decode(line)) if (emit(step)) steps.push(step);
      }
    };
    const emit = (line: string): boolean => {
      const clean = stripAnsi(line).trimEnd();
      if (clean) options.onLine(clean);
      return !!clean;
    };
    const out = lineReader(decoder ? (line) => decoder.lines(line) : undefined);
    const err = lineReader();

    // A multi-byte character split across two chunks would otherwise decode as garbage.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      if (!decoder && stdout.length < MAX_ANSWER_CHARS) stdout += text;
      out.push(text);
    });
    child.stderr?.on('data', (text: string) => {
      stderr = (stderr + text).slice(-MAX_ANSWER_CHARS);
      err.push(text);
    });

    const stop = () => {
      cancelled = true;
      killProcessTree(child);
    };
    options.signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);

    const finish = (failed: boolean, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', stop);
      out.end();
      err.end();
      // With a decoder, stdout was events: the answer is the one the CLI sent at the end, and
      // the steps join stderr as the log, which is what a run that never answered falls back on.
      const answer = decoder ? (decoder.answer() ?? '').slice(0, MAX_ANSWER_CHARS) : stdout;
      const log =
        decoder && steps.length > 0
          ? [stderr.trimEnd(), ...steps].filter(Boolean).join('\n')
          : stderr;
      resolve({ stdout: answer, stderr: log + extra, failed, cancelled, timedOut });
    };
    child.on('error', (error) => finish(true, `\nError: ${error.message}`));
    child.on('close', (code) => finish(code !== 0));

    // A CLI that exits before reading its prompt closes the pipe; that is its exit to report, not ours.
    child.stdin?.on('error', () => undefined);
    if (stdinPayload !== null) child.stdin?.end(stdinPayload, 'utf8');
    else child.stdin?.end();
  });
}
