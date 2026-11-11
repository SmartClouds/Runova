import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { buildOncePerRun, dotnetAvailable } from './devHost';
import { startWorkerDisplays } from './displays';
import { APP_ROOT, E2E_BUILD_ENV, E2E_OUT_DIR, MAIN_LOG_DIR } from './paths';

/**
 * Builds the app outside `out/`, so a running `electron-vite dev` (which owns that folder) is
 * left alone. Set RUNOVA_E2E_SKIP_BUILD=1 to reuse the last build while iterating on a test.
 *
 * Every run builds into a folder of its own under out-e2e/builds. With one shared folder, a run
 * that started while another was going deleted and rebuilt the app under it: the other run's
 * next launch found no main entry, and a page reload found no index.html. That happens whenever
 * the app's test runner and a developer (or two agents) run e2e specs at the same time.
 *
 * A run marks the build it uses with a lease, an empty file under out-e2e/leases whose name is
 * the run's id and the build's id. Each run sweeps away the builds that no live run holds,
 * except the newest finished one, which RUNOVA_E2E_SKIP_BUILD reuses.
 */

const BUILDS_DIR = join(E2E_OUT_DIR, 'builds');
const LEASES_DIR = join(E2E_OUT_DIR, 'leases');
/** Written last, so a build without it never finished. */
const FINISHED = 'finished';
const LEASE_SEPARATOR = '+';

export default async function globalSetup(config: FullConfig): Promise<() => void> {
  // Workers inherit this, so things built once per run (the DevHost) know whether this run has.
  // It names this run's build and lease too.
  const runId = `${process.pid}-${Date.now()}`;
  process.env.RUNOVA_E2E_RUN_ID = runId;
  // Playwright only sweeps its own output folder, so last run's app logs are cleared here.
  rmSync(MAIN_LOG_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.env[E2E_BUILD_ENV] = takeBuild(runId);
  // Built in a worker, the DevHost starves the Electron of every other worker and eats the build's
  // own spec's hook time: on a busy CI machine it took over seven minutes and failed both. That
  // holds for one worker too, where the first DevHost spec (cloudflareServer) paid for the whole
  // build inside its beforeAll and timed out on a busy machine, so every run builds it here.
  if (dotnetAvailable()) await buildOncePerRun();
  const stopDisplays = await startWorkerDisplays(config.workers);
  // The function returned is Playwright's global teardown. The build stays for the next
  // RUNOVA_E2E_SKIP_BUILD run; only the lease goes.
  return () => {
    stopDisplays?.();
    releaseLeases(runId);
  };
}

/** Returns the folder of the build this run will launch, building one when it has to. */
function takeBuild(runId: string): string {
  mkdirSync(BUILDS_DIR, { recursive: true });
  mkdirSync(LEASES_DIR, { recursive: true });
  if (process.env.RUNOVA_E2E_SKIP_BUILD === '1') {
    const latest = newestFinishedBuild();
    if (latest) {
      lease(runId, latest);
      // Once a newer build has finished, another run's sweep can take this one before the
      // lease is written. Then this run builds its own.
      if (existsSync(join(BUILDS_DIR, latest, FINISHED))) {
        sweep();
        return join(BUILDS_DIR, latest);
      }
      releaseLeases(runId);
    }
  }
  // Leased before it exists, so a sweep in another run never takes a build that is still going.
  lease(runId, runId);
  const dir = join(BUILDS_DIR, runId);
  buildApp(dir);
  writeFileSync(join(dir, FINISHED), '');
  sweep();
  return dir;
}

function buildApp(dir: string): void {
  // The app imports core, protocol and studio from their dist folders, so an old build of those
  // fails the app build on any export added since. The root test:e2e script builds them first,
  // but running Playwright directly skips that script. It only takes a few seconds.
  execSync('pnpm run build:packages', { cwd: join(APP_ROOT, '..', '..'), stdio: 'inherit' });
  // An absolute outDir puts main, preload and renderer side by side in it, which is where main
  // looks for the renderer. A relative one would resolve the renderer's under src/renderer.
  execSync(`pnpm exec electron-vite build --outDir "${dir}"`, { cwd: APP_ROOT, stdio: 'inherit' });
  if (!existsSync(join(dir, 'renderer', 'index.html'))) {
    throw new Error('e2e build has no renderer/index.html');
  }
}

function lease(runId: string, buildId: string): void {
  writeFileSync(join(LEASES_DIR, `${runId}${LEASE_SEPARATOR}${buildId}`), '');
}

function releaseLeases(runId: string): void {
  for (const name of list(LEASES_DIR)) {
    if (name.startsWith(`${runId}${LEASE_SEPARATOR}`)) remove(join(LEASES_DIR, name));
  }
}

/** Build and run ids are `<pid>-<ms>`, so the newest build has the largest time. */
function newestFinishedBuild(): string | undefined {
  const finished = list(BUILDS_DIR).filter((id) => existsSync(join(BUILDS_DIR, id, FINISHED)));
  return finished.sort((a, b) => timeOf(b) - timeOf(a))[0];
}

function timeOf(id: string): number {
  return Number(id.split('-')[1]) || 0;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process is there, it just isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Deletes the builds no live run holds, keeping the newest finished one. A run that was killed
 * never got to its teardown, so a lease whose run is gone is cleared here too.
 */
function sweep(): void {
  const keep = new Set<string>();
  const newest = newestFinishedBuild();
  if (newest) keep.add(newest);
  for (const name of list(LEASES_DIR)) {
    const [runId, buildId] = name.split(LEASE_SEPARATOR);
    if (runId && buildId && isAlive(Number(runId.split('-')[0]))) keep.add(buildId);
    else remove(join(LEASES_DIR, name));
  }
  for (const id of list(BUILDS_DIR)) {
    if (!keep.has(id)) remove(join(BUILDS_DIR, id));
  }
  // Builds from before the per-run folders sat at the top of out-e2e.
  for (const old of ['main', 'preload', 'renderer']) remove(join(E2E_OUT_DIR, old));
  remove(join(APP_ROOT, 'src', 'renderer', 'out-e2e'));
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Best effort: Windows refuses while a file is open, and the next sweep tries again. */
function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    // Left for the next sweep.
  }
}
