import { type RelayKnownPackage, type RelayRevisit, workaroundRevisit } from '@runova/core';
import { listProjectPackages } from '../ipc/packageManagers';
import { readItems } from './planFiles';
import type { RelayFolder } from './taskFiles';

/**
 * Which open workarounds can go (E122): the package check says the version each waits for is out
 * or installed, or its revisit date has passed. The package scan asks the registries, so it only
 * runs when some workaround names a package and a version.
 */
export async function workaroundRevisits(
  projectId: string,
  folder: RelayFolder,
  scan: typeof listProjectPackages = listProjectPackages,
  now: Date = new Date(),
): Promise<RelayRevisit[]> {
  const open = (await readItems(folder, 'workaround')).filter((item) => item.status === 'open');
  if (open.length === 0) return [];
  let packages: RelayKnownPackage[] = [];
  if (open.some((item) => item.dependency && item.waitingFor)) {
    const result = await scan(projectId).catch(() => null);
    packages =
      result?.sections.flatMap((section) =>
        section.packages.map((entry) => ({
          name: entry.name,
          ecosystem: section.ecosystem,
          current: entry.currentVersion,
          latest: entry.latestVersion,
        })),
      ) ?? [];
  }
  const today = now.toISOString().slice(0, 10);
  return open.map((item) => workaroundRevisit(item, packages, today));
}
