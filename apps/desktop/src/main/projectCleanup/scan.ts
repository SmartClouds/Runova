import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CleanupCandidate } from '../../shared/projectCleanupTypes';
import { limiter } from '../util/limiter';
import { gitFacts } from './gitFilter';
import { type CleanupLock, folded, lockReasonFor } from './locks';
import {
  type CleanupRule,
  markersSatisfied,
  needsChildren,
  type PackageManager,
  restoreHint,
  ruleForName,
} from './rules';
import { type MeasureFs, measureTree } from './sizeWalk';

/**
 * Looks through one folder of a project (the project itself, or one of its worktrees) for the
 * folders it can rebuild, and for how much the whole folder weighs.
 *
 * One walk does both. A folder with a rule and its marker is set aside and not entered, so what
 * is inside it is attributed to it and never listed twice; everything else is counted as the
 * project's own files. Git is asked once, after the walk, which of the set-aside folders are
 * tracked or ignored, and only then are they measured, so nothing is reported that is later taken
 * back.
 */

export interface ScanLocationInput {
  /** `main` for the project folder, the worktree's id otherwise. */
  locationId: string;
  root: string;
  /** Other locations that sit inside this one. They are left out, so nothing is counted twice. */
  skipRoots?: readonly string[];
  /**
   * Folders a deploy keeps in sync, each with the reason shown for it. A folder inside one is
   * locked, and so is a folder that contains one. `exceptNames` are folders inside it the deploy
   * never ships, which stay free to delete.
   */
  locks?: readonly CleanupLock[];
  /** Folder names not to offer here, such as `vendor` in a WordPress project. */
  excludeNames?: ReadonlySet<string>;
}

export interface ScanLocationOptions {
  signal?: AbortSignal;
  fs?: MeasureFs;
  /** Called as each offered folder is measured. */
  onCandidate?: (candidate: CleanupCandidate) => void;
  /** Called with how many files have been looked at so far, every `progressEvery` files. */
  onProgress?: (files: number) => void;
  progressEvery?: number;
}

export interface ScanLocationResult {
  /** Everything in the folder, the git history and the folders offered included. */
  totalBytes: number;
  /** The `.git` folder, which is read and never offered. */
  gitBytes: number;
  /** Biggest first. */
  candidates: CleanupCandidate[];
  unreadable: number;
}

const WALK_CONCURRENCY = 32;
/** Folders measured at once. Each measurement also limits its own reads. */
const MEASURE_CONCURRENCY = 2;
const DEFAULT_PROGRESS_EVERY = 250;

const realFs: MeasureFs = {
  readdir: (path) => readdir(path, { withFileTypes: true }),
  lstat: (path) => lstat(path),
};

interface SetAside {
  rule: CleanupRule;
  path: string;
  rel: string;
  manager: PackageManager | null;
}

function abortError(): Error {
  return new DOMException('The scan was cancelled.', 'AbortError');
}

function lockfileIn(names: ReadonlySet<string>): PackageManager | null {
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun';
  if (names.has('package-lock.json')) return 'npm';
  return null;
}

export async function scanLocation(
  input: ScanLocationInput,
  options: ScanLocationOptions = {},
): Promise<ScanLocationResult> {
  const { signal, fs = realFs, onCandidate, onProgress } = options;
  const progressEvery = options.progressEvery ?? DEFAULT_PROGRESS_EVERY;
  const root = resolve(input.root);
  const skip = new Set((input.skipRoots ?? []).map(folded));
  const limit = limiter(WALK_CONCURRENCY);

  const setAside: SetAside[] = [];
  let ownBytes = 0;
  let gitBytes = 0;
  let unreadable = 0;
  let seen = 0;
  let reported = 0;

  const checkAborted = (): void => {
    if (signal?.aborted) throw abortError();
  };

  function sawFiles(count: number): void {
    seen += count;
    if (onProgress && seen - reported >= progressEvery) {
      reported = seen;
      onProgress(seen);
    }
  }

  function problem(error: unknown): void {
    checkAborted();
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable += 1;
  }

  const entriesOf = (path: string) =>
    limit(async () => {
      checkAborted();
      return fs.readdir(path);
    });

  async function namesIn(path: string): Promise<ReadonlySet<string>> {
    try {
      return new Set((await entriesOf(path)).map((entry) => entry.name));
    } catch (error) {
      problem(error);
      return new Set();
    }
  }

  async function visit(dir: string, rel: string, inherited: PackageManager | null): Promise<void> {
    let entries: Awaited<ReturnType<typeof entriesOf>>;
    try {
      entries = await entriesOf(dir);
    } catch (error) {
      problem(error);
      return;
    }
    const siblings = new Set(entries.map((entry) => entry.name));
    const manager = lockfileIn(siblings) ?? inherited;

    await Promise.all(
      entries.map(async (entry) => {
        // A link is never followed, and what it points at is not this project's weight.
        if (entry.isSymbolicLink()) return;
        const path = join(dir, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;

        if (!entry.isDirectory()) {
          try {
            const info = await limit(async () => {
              checkAborted();
              return fs.lstat(path);
            });
            ownBytes += info.size;
            sawFiles(1);
          } catch (error) {
            problem(error);
          }
          return;
        }

        if (skip.has(folded(path))) return;

        if (rel === '' && entry.name === '.git') {
          const git = await measureTree(path, { signal, fs });
          gitBytes += git.bytes;
          unreadable += git.unreadable;
          sawFiles(git.files);
          return;
        }

        const rule = input.excludeNames?.has(entry.name) ? null : ruleForName(entry.name);
        if (rule) {
          const children = needsChildren(rule) ? await namesIn(path) : undefined;
          if (markersSatisfied(rule, siblings, children)) {
            setAside.push({ rule, path, rel: childRel, manager });
            return;
          }
        }
        await visit(path, childRel, manager);
      }),
    );
  }

  checkAborted();
  await visit(root, '', null);
  checkAborted();

  const facts = await gitFacts(
    root,
    setAside.map((found) => found.rel),
  );
  checkAborted();

  const locks = input.locks ?? [];
  const candidates: CleanupCandidate[] = [];
  let setAsideBytes = 0;

  const queue = [...setAside];
  async function measureNext(): Promise<void> {
    for (let found = queue.shift(); found; found = queue.shift()) {
      let last = 0;
      const size = await measureTree(found.path, {
        signal,
        fs,
        onFiles: (count) => {
          sawFiles(count - last);
          last = count;
        },
      });
      sawFiles(size.files - last);
      unreadable += size.unreadable;
      setAsideBytes += size.bytes;

      if (facts.tracked.has(found.rel)) continue;
      if (facts.inRepo && found.rule.ambiguous && !facts.ignored.has(found.rel)) continue;

      const candidate: CleanupCandidate = {
        id: `${input.locationId}:${found.rel}`,
        locationId: input.locationId,
        relPath: found.rel,
        name: found.rule.name,
        category: found.rule.category,
        bytes: size.bytes,
        sharedBytes: size.sharedBytes,
        files: size.files,
        modifiedAt: size.newestMs,
        restore: restoreHint(found.rule, found.manager),
        locked: lockReasonFor(found.path, found.rule.name, locks),
      };
      candidates.push(candidate);
      onCandidate?.(candidate);
    }
  }
  await Promise.all(Array.from({ length: MEASURE_CONCURRENCY }, () => measureNext()));

  candidates.sort((a, b) => b.bytes - a.bytes || a.relPath.localeCompare(b.relPath));
  return {
    totalBytes: ownBytes + gitBytes + setAsideBytes,
    gitBytes,
    candidates,
    unreadable,
  };
}
