import { type CatalogInstall, readCatalogInstall } from '@runova/core';
import type {
  StackDetails,
  StackInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployAppReleases } from '@shared/deployAppStoreTypes';
import { useQueries, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { useStack, useStacks } from '../apps/hooks';

/**
 * What the App Store reads: the apps it installed (known by the block their compose file carries)
 * and one of them with its live revision's files. The compose file never holds a secret, so it
 * can be read here; the passwords stay on the server.
 */

/** The description an install gives its app, which picks the App Store's apps out of the rest. */
export const storeDescription = (name: string) => `${name} from the App Store`;
const FROM_STORE = / from the App Store$/;

/** The revision whose files say what the app is: the live one, else the newest. */
export function shownRevision(stack: StackInfo): number | null {
  return stack.liveRevision ?? (stack.revisionCount > 0 ? stack.revisionCount : null);
}

function filesQuery(serverId: string, stackId: string, revision: number, enabled: boolean) {
  return {
    queryKey: queryKeys.deployAppFiles(serverId, stackId, revision),
    queryFn: () => window.runova.deployStacks.files({ serverId, stackId, revision }),
    enabled,
    retry: false,
    // A revision's files never change; only a new revision brings new ones.
    staleTime: Number.POSITIVE_INFINITY,
  };
}

/** The catalog as it shipped, when the registries have not been read. */
const NO_RELEASES: DeployAppReleases = { data: null, checkedAtUnixMs: null, error: null };

/**
 * The newest releases of the catalog's images (the main process reads them from the registries
 * and keeps them for hours). While they load, and when they cannot be read, the catalog is what
 * it shipped with.
 */
export function useAppStoreReleases(): DeployAppReleases & { loading: boolean } {
  const releases = useQuery({
    queryKey: queryKeys.deployAppStoreReleases(),
    queryFn: async () => (await window.runova.deployAppStore.releases()) ?? NO_RELEASES,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const reading = releases.data ?? NO_RELEASES;
  return {
    ...reading,
    error: reading.error ?? (releases.error ? 'The image registries could not be reached.' : null),
    loading: releases.isPending,
  };
}

export interface InstalledStoreApp {
  stack: StackInfo;
  install: CatalogInstall;
}

export function useInstalledApps(serverId: string, enabled: boolean) {
  const stacks = useStacks(serverId, enabled);
  const candidates = (stacks.data ?? []).filter(
    (stack) => FROM_STORE.test(stack.description ?? '') && shownRevision(stack) !== null,
  );
  const files = useQueries({
    queries: candidates.map((stack) =>
      filesQuery(serverId, stack.id, shownRevision(stack) ?? 1, enabled),
    ),
  });
  const apps: InstalledStoreApp[] = [];
  candidates.forEach((stack, index) => {
    const compose = files[index]?.data?.compose;
    if (!compose) return;
    const read = readCatalogInstall(compose);
    if (read.ok) apps.push({ stack, install: read.install });
  });
  return {
    apps,
    stacks: stacks.data,
    loading: stacks.isPending || files.some((query) => query.isPending),
    error: stacks.error,
    refetch: () => void stacks.refetch(),
  };
}

export interface InstalledApp {
  details: StackDetails | undefined;
  detailsError: unknown;
  revision: number | null;
  install: CatalogInstall | null;
  /** Why the files do not describe an App Store install, once they are read. */
  problem: string | null;
  loading: boolean;
}

/** One installed app, read again quickly while a job runs on it (or `following` says so). */
export function useInstalledApp(
  serverId: string,
  stackId: string,
  enabled: boolean,
  following: boolean,
): InstalledApp {
  const details = useStack(serverId, stackId, enabled, following);
  const revision = details.data ? shownRevision(details.data.stack) : null;
  const files = useQuery(
    filesQuery(serverId, stackId, revision ?? 1, enabled && revision !== null),
  );
  const read = files.data ? readCatalogInstall(files.data.compose) : null;
  return {
    details: details.data,
    detailsError: details.error,
    revision,
    install: read?.ok ? read.install : null,
    problem: read && !read.ok ? read.reason : null,
    loading: details.isPending || (revision !== null && files.isPending),
  };
}
