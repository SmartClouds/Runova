// Points TMPDIR (and TMP, TEMP) at a new folder for this job, which post.mjs deletes when the job
// ends. Tests make temp folders all the time, and a test that fails, times out or is cancelled
// leaves its folders behind. On the Mac this also keeps them out of its user's own temp folder.

import { appendFileSync, mkdtempSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import {
  busiestProcessesIn,
  cleanWorkspace,
  keepsDependencies,
  removeTree,
  run,
  skipReason,
  strayProcessesIn,
  TEMP_PREFIX,
  TEMP_ROOT,
  warn,
} from './shared.mjs';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const skip = skipReason();

/** Sends a signal, and is fine when the process has already gone. */
function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== 'ESRCH') warn(`Could not send ${name} to ${pid}: ${error.message}`);
  }
}

// A process an earlier job left behind. One `pnpm self-update` from Setup pnpm kept nine of the
// Mac's ten cores busy for a day and a half (from 2026-11-09), and every job on the Mac ran out of
// time or had its tests time out until it was found.
if (!skip) {
  try {
    const ps = run('ps', ['-A', '-o', 'pid=,ppid=,uid=,etime=,command='], { timeout: 30_000 });
    if (ps.status !== 0) throw new Error(ps.stderr.trim() || `ps exited with ${ps.status}`);
    const workRoot = dirname(process.env.RUNNER_TOOL_CACHE);
    const strays = strayProcessesIn(ps.stdout, { uid: process.getuid(), workRoot });
    for (const { pid, age, command } of strays) {
      const hours = Math.round(age / 3600);
      warn(`Stopping ${pid}, which an earlier job started ${hours} hours ago: ${command}`);
      signal(pid, 'SIGTERM');
    }
    if (strays.length > 0) {
      run('sleep', ['5']);
      for (const { pid } of strays) signal(pid, 'SIGKILL');
    } else {
      console.log('No process left behind by an earlier job.');
    }
  } catch (error) {
    warn(`Could not look for processes left behind by an earlier job: ${error.message}`);
  }
}

// How busy the machine is as the job starts, for when a job runs slow. The Linux runner took 30
// minutes for builds the Mac does in two, and nothing in the job logs said why.
if (!skip) {
  try {
    const load = loadavg()
      .map((n) => n.toFixed(1))
      .join(' ');
    console.log(`Load ${load} on ${availableParallelism()} CPUs. Busiest processes:`);
    const ps = run('ps', ['-A', '-o', 'pid=,pcpu=,etime=,command='], { timeout: 30_000 });
    if (ps.status !== 0) throw new Error(ps.stderr.trim() || `ps exited with ${ps.status}`);
    for (const line of busiestProcessesIn(ps.stdout)) console.log(`  ${line}`);
  } catch (error) {
    warn(`Could not tell how busy the machine is: ${error.message}`);
  }
}

// pnpm's store has to live somewhere that survives the job. pnpm/action-setup sets PNPM_HOME to
// <dest>/node_modules/.bin, which puts pnpm's default store inside <dest>, and it deletes <dest>
// before every install. So every job started with an empty store and downloaded all ~1,400
// packages again (about 1 GB on the Mac), and one slow registry response stalled the whole job.
// The tool cache is per runner, so two runners on one machine never share a store. The extra
// fetch retries are for the cold store after a runner is set up again, when everything downloads.
// pnpm's own install keeps a store of its own (the Setup pnpm steps say why).
if (!skip) {
  try {
    const store = join(process.env.RUNNER_TOOL_CACHE, 'pnpm-store');
    appendFileSync(
      process.env.GITHUB_ENV,
      `pnpm_config_store_dir=${store}\npnpm_config_fetch_retries=5\n`,
    );
    console.log(`pnpm's store is ${store}.`);
  } catch (error) {
    warn(`Could not move pnpm's store out of the setup folder: ${error.message}`);
  }
}

// Where node_modules stays between jobs, the checkout leaves the workspace alone, so this clears
// the rest: an earlier commit's builds, blob reports and test results. Doing it here rather than
// after the job also covers a job whose runner died before its post step.
if (!skip && keepsDependencies()) {
  try {
    const started = Date.now();
    cleanWorkspace({ keepDependencies: true });
    console.log(`That took ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  } catch (error) {
    warn(`Could not clean the workspace: ${error.message}`);
  }
}

try {
  if (skip) {
    console.log(`Nothing to do: ${skip}`);
  } else {
    const root = realpathSync(TEMP_ROOT);

    // A job whose runner died never ran its post step. No job runs this long, so a folder this
    // old cannot belong to a job that is still running on another runner of the same machine.
    for (const name of readdirSync(root)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(root, name);
      try {
        const stats = statSync(path);
        if (stats.uid !== process.getuid()) continue;
        if (Date.now() - stats.mtimeMs < STALE_AFTER_MS) continue;
      } catch {
        continue;
      }
      if (removeTree(path)) console.log(`Deleted ${path}, left behind by an earlier job.`);
    }

    const tmp = mkdtempSync(join(root, TEMP_PREFIX));
    appendFileSync(process.env.GITHUB_ENV, `TMPDIR=${tmp}\nTMP=${tmp}\nTEMP=${tmp}\n`);
    appendFileSync(process.env.GITHUB_STATE, `tmpdir=${tmp}\n`);
    console.log(`This job's temp folder is ${tmp}.`);
  }
} catch (error) {
  // The job runs fine on the default temp folder, it only leaves more behind.
  warn(`Could not give the job its own temp folder: ${error.message}`);
}
