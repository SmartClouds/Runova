import type { PackageManagerSection } from '../../shared/apiTypes';
import { type InventoryPackage, tidyInventory } from '../../shared/dependencyAlerts';
import { dartAdapter } from './dartAdapter';
import { dotnetAdapter } from './dotnetAdapter';
import { nodeAdapter } from './nodeAdapter';
import type { PackageManagerAdapter } from './types';

export const PACKAGE_MANAGER_ADAPTERS: PackageManagerAdapter[] = [
  nodeAdapter,
  dotnetAdapter,
  dartAdapter,
];

export async function scanProjectPackages(folderPath: string): Promise<PackageManagerSection[]> {
  const detected = await Promise.all(
    PACKAGE_MANAGER_ADAPTERS.map(async (adapter) => ({
      adapter,
      matched: await adapter.detect(folderPath),
    })),
  );
  const sections = await Promise.all(
    detected.filter((d) => d.matched).map((d) => d.adapter.listPackages(folderPath)),
  );
  return sections.flat();
}

/** Every ecosystem's direct dependencies in the folder, from the files alone (E51). */
export async function readProjectInventory(folderPath: string): Promise<InventoryPackage[]> {
  const found = await Promise.all(
    PACKAGE_MANAGER_ADAPTERS.map(async (adapter) =>
      (await adapter.detect(folderPath)) ? adapter.readInventory(folderPath) : [],
    ),
  );
  return tidyInventory(found.flat());
}

export type { PackageManagerAdapter, UpdateProgressTick } from './types';
