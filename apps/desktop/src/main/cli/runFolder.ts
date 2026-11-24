import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs `work` in a folder made for it, then removes the folder. For a headless CLI run that needs
 * no project: the shared temp folder itself is /tmp on Linux, where any local account can leave a
 * .claude, .gemini or opencode.json for an agent CLI to load as its project config. mkdtemp makes
 * the folder 0700, so nobody else can put anything in it.
 */
export async function inPrivateRunFolder<T>(work: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'runova-run-'));
  try {
    return await work(cwd);
  } finally {
    // A CLI that was just killed can hold a file for a moment on Windows.
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  }
}
