import { join } from 'node:path';
import { WP_DEFAULT_IGNORE, wpItemRoot } from '@runova/core';
import { readFileSites } from '../deploy/files/store';
import { store } from '../store';
import { studioService } from '../studio';
import { listProjectWorktrees } from '../worktrees/service';
import type { CleanupLock } from './locks';
import type { CleanupDeps } from './service';

/**
 * Folders a WordPress deploy leaves out by default (`node_modules/`, `.cache/` and the like), by
 * name. They are never on the site, so deleting them is never read as a remote delete.
 */
const WP_UNSHIPPED_FOLDERS: ReadonlySet<string> = new Set(
  WP_DEFAULT_IGNORE.filter((line) => line.endsWith('/') && !line.startsWith('/')).map((line) =>
    line.slice(0, -1),
  ),
);

/** The real app behind the clean-up service: the project store, git worktrees, deploy and Studio. */
export function createCleanupDeps(): CleanupDeps {
  return {
    async getProject(projectId) {
      const project = (await store.getProjects()).find((p) => p.id === projectId);
      return project
        ? { id: project.id, name: project.name, folderPath: project.folderPath }
        : null;
    },

    async worktrees(projectId) {
      return (await listProjectWorktrees(projectId)).map((worktree) => ({
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        missing: worktree.missing,
      }));
    },

    async locks(projectId, locationPath) {
      const locks: CleanupLock[] = [];

      for (const site of await readFileSites()) {
        if (!site.projectIds.includes(projectId)) continue;
        locks.push({
          path: site.localFolder,
          reason: `Kept in step with the deploy site "${site.label}".`,
        });
      }

      const project = (await store.getProjects()).find((p) => p.id === projectId);
      for (const item of project?.wordpress?.items ?? []) {
        locks.push({
          path: join(locationPath, ...wpItemRoot(item).split('/')),
          reason: 'Part of a WordPress item that is deployed to the site.',
          exceptNames: WP_UNSHIPPED_FOLDERS,
        });
      }
      return locks;
    },

    studio: {
      async usage(projectId) {
        return (await studioService().cacheUsage({ projectId })).videos;
      },
      clear(videoIds) {
        return studioService().clearCache({ videoIds });
      },
    },
  };
}
