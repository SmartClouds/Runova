import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  type PlanFileChange,
  planCommitMessage,
  RELAY_STATUS_FILE,
  renderStatusFile,
  tasksFolderRelPath,
} from '@runova/core';
import { git as runGit } from '../git/plumbing';
import { findProjectScope } from '../worktrees/resolve';
import { readAllItems, readPlan } from './planFiles';
import { relaySettings } from './store';
import { type RelayFolder, readBoardFiles, relayFolder, writeAtomic } from './taskFiles';

/**
 * Plan sync through git (E123). After the plan folder changes (an edit in the app or on the phone,
 * a finished session), the committer waits a few seconds for more, refreshes STATUS.md, and commits
 * only that folder with a pathspec, so nothing else the person has staged goes in. Pushing stays
 * the person's call. It does nothing in a repo with no commits or in the middle of a merge, a
 * rebase or a cherry-pick, and a project can turn it off.
 */

export interface PlanCommitTarget {
  /** The project folder, where git runs. */
  cwd: string;
  folder: RelayFolder;
  enabled: boolean;
}

export type PlanCommitOutcome =
  | { kind: 'committed'; hash: string; message: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string };

export interface PlanCommitterDeps {
  delayMs: number;
  target(projectId: string): Promise<PlanCommitTarget | null>;
  git(cwd: string, args: string[]): Promise<string>;
  onOutcome?(projectId: string, outcome: PlanCommitOutcome): void;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Rewrites STATUS.md from the plan when what it says has changed. */
export async function refreshStatusFile(folder: RelayFolder): Promise<boolean> {
  const [plan, items, board] = await Promise.all([
    readPlan(folder),
    readAllItems(folder),
    readBoardFiles(folder),
  ]);
  if (!board.exists) return false;
  const next = renderStatusFile({ plan, items, tasks: board.files.map((file) => file.task) });
  const path = join(folder.tasksDir, RELAY_STATUS_FILE);
  const current = await readFile(path, 'utf-8').catch(() => null);
  if (current === next) return false;
  await writeAtomic(path, next);
  return true;
}

/** Parses `git status --porcelain -z` into changes under one folder, relative to it. */
export function changesUnder(porcelain: string, folderFromRoot: string): PlanFileChange[] {
  const prefix = folderFromRoot ? `${folderFromRoot.replace(/\/+$/, '')}/` : '';
  const entries = porcelain.split('\0').filter(Boolean);
  const changes: PlanFileChange[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename carries its old path as the next entry.
    if (code.startsWith('R') || code.startsWith('C')) index += 1;
    if (!path.startsWith(prefix)) continue;
    changes.push({ code, path: path.slice(prefix.length) });
  }
  return changes;
}

export function createPlanCommitter(deps: PlanCommitterDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<PlanCommitOutcome>>();

  async function commitNow(projectId: string): Promise<PlanCommitOutcome> {
    const target = await deps.target(projectId).catch(() => null);
    if (!target) return { kind: 'skipped', reason: 'no project' };
    if (!target.enabled) return { kind: 'skipped', reason: 'turned off' };
    const git = (args: string[]) => deps.git(target.cwd, args);
    const inside = await git(['rev-parse', '--is-inside-work-tree']).catch(() => '');
    if (inside.trim() !== 'true') return { kind: 'skipped', reason: 'not a git repository' };
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
    if (!head.trim()) return { kind: 'skipped', reason: 'no commits yet' };
    for (const marker of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      const path = (await git(['rev-parse', '--git-path', marker]).catch(() => '')).trim();
      if (path && (await exists(isAbsolute(path) ? path : join(target.cwd, path)))) {
        return { kind: 'skipped', reason: 'a merge or rebase is in progress' };
      }
    }

    await refreshStatusFile(target.folder).catch(() => false);
    const tasks = tasksFolderRelPath(target.folder.docsFolder);
    const prefix = (await git(['rev-parse', '--show-prefix']).catch(() => '')).trim();
    const porcelain = await git([
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      tasks,
    ]).catch(() => '');
    const changes = changesUnder(porcelain, `${prefix}${tasks}`);
    if (changes.length === 0) return { kind: 'skipped', reason: 'nothing changed' };
    const message = planCommitMessage(changes);
    try {
      await git(['add', '-A', '--', tasks]);
      // With a pathspec, git commits only these paths and leaves whatever else is staged alone.
      await git(['commit', '--quiet', '-m', message, '--', tasks]);
      const hash = (await git(['rev-parse', '--short', 'HEAD'])).trim();
      return { kind: 'committed', hash, message };
    } catch (error) {
      const stderr = (error as { stderr?: string } | null)?.stderr?.trim();
      return {
        kind: 'failed',
        error: stderr || (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  /** Commits the plan folder of a project now, after any commit already running for it. */
  function flush(projectId: string): Promise<PlanCommitOutcome> {
    const timer = timers.get(projectId);
    if (timer) clearTimeout(timer);
    timers.delete(projectId);
    const previous = running.get(projectId) ?? Promise.resolve(null);
    const next = previous.then(() => commitNow(projectId));
    running.set(projectId, next);
    void next.then((outcome) => {
      if (running.get(projectId) === next) running.delete(projectId);
      deps.onOutcome?.(projectId, outcome);
    });
    return next;
  }

  /** Commits a project's plan folder once it has been quiet for the delay. */
  function schedule(projectId: string): void {
    const timer = timers.get(projectId);
    if (timer) clearTimeout(timer);
    const next = setTimeout(() => {
      timers.delete(projectId);
      void flush(projectId);
    }, deps.delayMs);
    // A commit still waiting never keeps the app (or a test run) from exiting.
    next.unref?.();
    timers.set(projectId, next);
  }

  function dispose(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { schedule, flush, dispose };
}

export type PlanCommitter = ReturnType<typeof createPlanCommitter>;

let shared: PlanCommitter | null = null;

/** The app's one committer, wired to the real projects, settings and git. */
export function planCommitter(): PlanCommitter {
  shared ??= createPlanCommitter({
    delayMs: 5_000,
    target: async (projectId) => {
      const project = await findProjectScope(projectId);
      if (!project) return null;
      const settings = await relaySettings(projectId);
      return {
        cwd: project.folderPath,
        folder: relayFolder(project.folderPath, settings.docsFolder),
        enabled: settings.options.commitPlan !== false,
      };
    },
    git: (cwd, args) => runGit(cwd, args),
  });
  return shared;
}

/** Asks for a plan commit after a change; quiet changes in a row make one commit. */
export function schedulePlanCommit(projectId: string): void {
  planCommitter().schedule(projectId);
}
