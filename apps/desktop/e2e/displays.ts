import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Every app on one X server shares its clipboard and its keyboard focus. With two workers on one
 * Xvfb, a spec copying in one Electron changed what the other read back, and a main process could
 * sit blocked in clipboard.readText() while the selection belonged to the other app. So on Linux,
 * with more than one worker, every worker gets an Xvfb of its own.
 */

const DISPLAYS_ENV = 'RUNOVA_E2E_DISPLAYS';
const START_TIMEOUT_MS = 10_000;
/** How much of Xvfb's own output is kept, for when it fails. */
const LOG_TAIL_CHARS = 4_000;

function startXvfb(): Promise<{ display: string; server: ChildProcess }> {
  return new Promise((resolve, reject) => {
    // -displayfd picks a free display number and prints it, so two runners on one machine never
    // reach for the same one. -noreset keeps the server as it is when its last app quits. Without
    // it, every test's Electron closing reset the server, which compiled its keymap again.
    const server = spawn(
      'Xvfb',
      ['-displayfd', '1', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-noreset'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Xvfb's stderr only goes to the log when something is wrong. A healthy start prints a
    // screenful: xkbcomp's warnings about keysyms Ubuntu's keyboard data has and it does not
    // know yet, and a line for every display number -displayfd found taken.
    let log = '';
    server.stderr?.on('data', (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-LOG_TAIL_CHARS);
    });
    let output = '';
    const fail = (reason: string) => {
      clearTimeout(timer);
      server.kill();
      reject(new Error(`Xvfb did not start: ${reason}\n${log}`));
    };
    const timer = setTimeout(() => fail('no display number after 10s'), START_TIMEOUT_MS);
    server.once('error', (error) => fail(error.message));
    server.once('exit', (code) => fail(`exited with ${code}`));
    server.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.match(/^(\d+)\n/);
      if (!line) return;
      clearTimeout(timer);
      server.removeAllListeners('exit');
      server.stdout?.removeAllListeners('data');
      const display = `:${line[1]}`;
      // A server that dies under a running test is worth its last words.
      server.once('exit', (code, signal) => {
        if (server.killed) return;
        // biome-ignore lint/suspicious/noConsole: the only record of why the display went away
        console.error(`Xvfb on ${display} exited (${signal ?? code}):\n${log}`);
      });
      resolve({ display, server });
    });
  });
}

/**
 * Starts one display per worker and hands the list to the workers through the environment.
 * Returns what stops them again, or nothing when this run doesn't need them.
 */
export async function startWorkerDisplays(workers: number): Promise<(() => void) | undefined> {
  if (process.platform !== 'linux' || workers < 2) return undefined;
  const servers: ChildProcess[] = [];
  const displays: string[] = [];
  const stop = () => {
    for (const server of servers) server.kill();
  };
  // One after another: started together, they race for the same free number.
  for (let worker = 0; worker < workers; worker++) {
    try {
      const { display, server } = await startXvfb();
      servers.push(server);
      displays.push(display);
    } catch (error) {
      stop();
      throw error;
    }
  }
  process.env[DISPLAYS_ENV] = displays.join(',');
  return stop;
}

/** The display global setup started for this worker, if it started any. */
export function workerDisplay(): string | undefined {
  const displays = process.env[DISPLAYS_ENV]?.split(',');
  const slot = Number(process.env.TEST_PARALLEL_INDEX);
  return displays && Number.isInteger(slot) ? displays[slot] : undefined;
}
