import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type CleanupLocation,
  type CleanupRemoveEvent,
  type CleanupRemoveItem,
  type CleanupRemoveResult,
  type CleanupScanEvent,
  type CleanupStudioVideo,
  cleanupItemKey,
  type ProjectCleanupScan,
} from '../../shared/projectCleanupTypes';
import { assertPathWithinRoots } from '../pathGuard';
import { gitFacts } from './gitFilter';
import { type CleanupLock, folded, isWithin, lockReasonFor } from './locks';
import { markersSatisfied, needsChildren, ruleForName } from './rules';
import { scanLocation } from './scan';

/**
 * The clean-up feature as a whole: which folders a project has (itself and its worktrees), what a
 * scan finds in each, and what a removal is allowed to delete.
 *
 * The window never names a path. It names a location the scan reported and a folder path inside
 * it, and every removal is checked again here against the same rules the scan used, so a request
 * for anything the scan would not have offered is refused no matter how it was made.
 */

export interface CleanupProject {
  id: string;
  name: string;
  folderPath: string;
}

export interface CleanupWorktree {
  id: string;
  path: string;
  branch: string | null;
  missing: boolean;
}

export interface CleanupStudioClear {
  freedBytes: number;
  cleared: string[];
  skipped: { videoId: string; reason: 'busy' | 'unknown' }[];
}

export interface CleanupDeps {
  getProject(projectId: string): Promise<CleanupProject | null>;
  worktrees(projectId: string): Promise<CleanupWorktree[]>;
  /** The folders of this checkout that a deploy keeps in step with a server. */
  locks(projectId: string, locationPath: string): Promise<CleanupLock[]>;
  studio: {
    usage(projectId: string): Promise<CleanupStudioVideo[]>;
    clear(videoIds: string[]): Promise<CleanupStudioClear>;
  };
  /** Deletes a folder tree. Defaults to `rm` with the retries Windows needs. */
  removeTree?: (path: string) => Promise<void>;
  now?: () => number;
}

export interface ScanHandlers {
  requestId?: string;
  signal?: AbortSignal;
  onEvent?: (event: CleanupScanEvent) => void;
}

export interface RemoveHandlers {
  requestId?: string;
  signal?: AbortSignal;
  onEvent?: (event: CleanupRemoveEvent) => void;
}

export interface ProjectCleanup {
  scan(projectId: string, handlers: ScanHandlers): Promise<ProjectCleanupScan>;
  remove(
    projectId: string,
    items: readonly CleanupRemoveItem[],
    handlers: RemoveHandlers,
  ): Promise<CleanupRemoveResult>;
}

interface LocationRoot {
  id: string;
  label: string;
  path: string;
  branch: string | null;
  isMain: boolean;
}

const MAIN = 'main';
const NO_PROJECT = 'That project no longer exists.';

function abortError(): Error {
  return new DOMException('The scan was cancelled.', 'AbortError');
}

async function defaultRemoveTree(path: string): Promise<void> {
  // Virus scanners and indexers hold files for a moment after they are touched.
  await rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}

/** A sentence for the person, in place of an error code. */
function describeRemoveError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
    return 'Something is still using it. Stop any dev server or terminal running in this folder, then try again.';
  }
  if (code === 'EACCES') {
    return 'Runova does not have permission to delete some of the files in it.';
  }
  return 'Could not delete it. Try again, or delete the folder yourself.';
}

/** The folder path split into names, or null for anything that is not a plain path inside. */
function plainSegments(relPath: string): string[] | null {
  if (!relPath || relPath.includes('\0') || relPath.includes('\\')) return null;
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) return null;
  const parts = relPath.split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..') ? null : parts;
}

async function namesIn(path: string): Promise<ReadonlySet<string>> {
  return new Set(await readdir(path).catch(() => [] as string[]));
}

export function createProjectCleanup(deps: CleanupDeps): ProjectCleanup {
  const removeTree = deps.removeTree ?? defaultRemoveTree;
  const now = deps.now ?? Date.now;
  /** What the last scan of each project said deleting each item would free. */
  const lastScan = new Map<string, Map<string, number>>();

  async function requireProject(projectId: string): Promise<CleanupProject> {
    const project = await deps.getProject(projectId);
    if (!project) throw new Error(NO_PROJECT);
    return project;
  }

  /**
   * The deploy locks for a checkout. When they cannot be read, the whole checkout is locked,
   * because not knowing what a deploy keeps in step is no reason to delete it.
   */
  async function locksFor(project: CleanupProject, root: LocationRoot): Promise<CleanupLock[]> {
    try {
      return await deps.locks(project.id, root.path);
    } catch {
      return [
        {
          path: root.path,
          reason: 'Could not check which folders a deploy uses, so nothing here can be deleted.',
        },
      ];
    }
  }

  async function locationRoots(project: CleanupProject): Promise<LocationRoot[]> {
    const worktrees = await deps.worktrees(project.id).catch(() => [] as CleanupWorktree[]);
    return [
      {
        id: MAIN,
        label: 'Project folder',
        path: resolve(project.folderPath),
        branch: null,
        isMain: true,
      },
      ...worktrees
        .filter((worktree) => !worktree.missing)
        .map((worktree) => ({
          id: worktree.id,
          label: worktree.branch ?? basename(worktree.path),
          path: resolve(worktree.path),
          branch: worktree.branch,
          isMain: false,
        })),
    ];
  }

  async function scan(projectId: string, handlers: ScanHandlers): Promise<ProjectCleanupScan> {
    const { requestId = '', signal, onEvent } = handlers;
    const project = await requireProject(projectId);
    const roots = await locationRoots(project);
    const free = new Map<string, number>();
    const locations: CleanupLocation[] = [];

    for (const root of roots) {
      if (signal?.aborted) throw abortError();
      onEvent?.({
        requestId,
        type: 'location',
        locationId: root.id,
        label: root.label,
        isMain: root.isMain,
      });
      const here = folded(root.path);
      const skipRoots = roots
        .filter((other) => other.id !== root.id && isWithin(folded(other.path), here))
        .map((other) => other.path);
      const result = await scanLocation(
        {
          locationId: root.id,
          root: root.path,
          skipRoots,
          locks: await locksFor(project, root),
        },
        {
          signal,
          onCandidate: (candidate) => onEvent?.({ requestId, type: 'candidate', candidate }),
          onProgress: (files) =>
            onEvent?.({ requestId, type: 'progress', locationId: root.id, files }),
        },
      );
      for (const candidate of result.candidates) {
        free.set(candidate.id, Math.max(0, candidate.bytes - candidate.sharedBytes));
      }
      locations.push({
        id: root.id,
        label: root.label,
        path: root.path,
        branch: root.branch,
        isMain: root.isMain,
        totalBytes: result.totalBytes,
        gitBytes: result.gitBytes,
        candidates: result.candidates,
        unreadable: result.unreadable,
      });
    }

    // Studio's cache is a bonus. If it cannot be read the folders are still worth showing.
    const studio = await deps.studio.usage(project.id).catch(() => [] as CleanupStudioVideo[]);
    for (const video of studio) free.set(`studio:${video.videoId}`, video.bytes);
    onEvent?.({ requestId, type: 'studio', videos: studio });

    lastScan.set(project.id, free);
    return { projectId: project.id, scannedAt: now(), locations, studio };
  }

  /** The folder to delete, or the reason it must not be. */
  async function checkFolder(
    project: CleanupProject,
    root: LocationRoot,
    relPath: string,
  ): Promise<string> {
    const parts = plainSegments(relPath);
    const name = parts?.at(-1);
    const rule = name ? ruleForName(name) : null;
    if (!parts || !name || !rule) throw new Error('Cleanup does not remove that folder.');

    const target = join(root.path, ...parts);
    const parent = dirname(target);
    await assertPathWithinRoots(parent, [root.path]);

    const info = await lstat(target).catch(() => null);
    if (!info) throw new Error('It is no longer there.');
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Cleanup only removes real folders, not links.');
    }

    const siblings = await namesIn(parent);
    const children = needsChildren(rule) ? await namesIn(target) : undefined;
    if (!markersSatisfied(rule, siblings, children)) {
      throw new Error('Nothing beside this folder shows it can be rebuilt, so it was left alone.');
    }

    const facts = await gitFacts(root.path, [relPath]);
    if (facts.tracked.has(relPath)) {
      throw new Error('Git tracks files in this folder, so it was left alone.');
    }
    if (facts.inRepo && rule.ambiguous && !facts.ignored.has(relPath)) {
      throw new Error('This folder is not ignored by git, so it may hold your own work.');
    }

    const locked = lockReasonFor(target, name, await locksFor(project, root));
    if (locked) throw new Error(locked);
    return target;
  }

  async function remove(
    projectId: string,
    items: readonly CleanupRemoveItem[],
    handlers: RemoveHandlers,
  ): Promise<CleanupRemoveResult> {
    const { requestId = '', signal, onEvent } = handlers;
    const project = await requireProject(projectId);
    const roots = await locationRoots(project);
    const expected = lastScan.get(project.id) ?? new Map<string, number>();
    const result: CleanupRemoveResult = { freedBytes: 0, removed: [], failed: [] };

    const fail = (key: string, error: string): void => {
      result.failed.push({ key, error });
      onEvent?.({ requestId, key, status: 'failed', error });
    };

    for (const item of items) {
      if (item.kind !== 'folder') continue;
      if (signal?.aborted) break;
      const key = cleanupItemKey(item);
      onEvent?.({ requestId, key, status: 'removing' });
      try {
        const root = roots.find((candidate) => candidate.id === item.locationId);
        if (!root) throw new Error('That location is not part of this project.');
        const target = await checkFolder(project, root, item.relPath);
        try {
          await removeTree(target);
        } catch (error) {
          fail(key, describeRemoveError(error));
          continue;
        }
        const freed = expected.get(key) ?? 0;
        result.freedBytes += freed;
        result.removed.push(key);
        onEvent?.({ requestId, key, status: 'done', freedBytes: freed });
      } catch (error) {
        fail(key, error instanceof Error ? error.message : describeRemoveError(error));
      }
    }

    const videos = items.filter((item) => item.kind === 'studio');
    if (videos.length > 0 && !signal?.aborted) {
      const ids = videos.map((item) => item.videoId);
      for (const item of videos) {
        onEvent?.({ requestId, key: cleanupItemKey(item), status: 'removing' });
      }
      try {
        const cleared = await deps.studio.clear(ids);
        const skipped = new Map(cleared.skipped.map((skip) => [skip.videoId, skip.reason]));
        for (const item of videos) {
          const key = cleanupItemKey(item);
          if (cleared.cleared.includes(item.videoId)) {
            result.removed.push(key);
            onEvent?.({
              requestId,
              key,
              status: 'done',
              freedBytes: expected.get(key) ?? 0,
            });
          } else if (skipped.get(item.videoId) === 'busy') {
            fail(key, 'This video is rendering. Try again when the render is done.');
          } else if (skipped.get(item.videoId) === 'unknown') {
            fail(key, 'That video is no longer in the Studio library.');
          } else {
            fail(key, 'Could not clear the cache. Try again.');
          }
        }
        result.freedBytes += cleared.freedBytes;
      } catch {
        for (const item of videos)
          fail(cleanupItemKey(item), 'Could not clear the cache. Try again.');
      }
    }

    return result;
  }

  return { scan, remove };
}
