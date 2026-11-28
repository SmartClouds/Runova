import type { PackageScanResult } from '../../shared/apiTypes';
import { findProjectScope } from '../worktrees/resolve';
import { scanProjectPackages } from './index';

/**
 * Kept apart from the package IPC handlers, which reach the account and through it most of the
 * app: Relay reads the package list too, and loading all of that for it made its first call slow.
 */

/** The folder of a project or worktree, or an error naming the id when there is none. */
export async function projectFolderPath(projectId: string): Promise<string> {
  const project = await findProjectScope(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return project.folderPath;
}

/** A project's packages and runtime targets, as the Packages tab lists them. */
export async function listProjectPackages(projectId: string): Promise<PackageScanResult> {
  const folderPath = await projectFolderPath(projectId);
  return { projectId, sections: await scanProjectPackages(folderPath) };
}
