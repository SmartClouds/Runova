import type { RunnerCleanupOs } from '../../../shared/apiTypes';

/**
 * The package caches CI jobs fill on a runner machine (E104), where each OS keeps them, and the
 * tool command that empties one when the tool is installed. Paths are relative to a home folder
 * (or to `%LOCALAPPDATA%` on Windows), since a runner machine can have more than one user.
 */

export type CacheId =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'pip'
  | 'gradle'
  | 'maven'
  | 'nuget'
  | 'go'
  | 'cargo';

export type CacheBase = 'home' | 'localAppData';

export interface CacheCommand {
  tool: string;
  args: string[];
}

interface CacheWhere {
  base: CacheBase;
  rel: string;
}

export interface CacheCatalogEntry {
  id: CacheId;
  label: string;
  paths: Record<RunnerCleanupOs, CacheWhere>;
  command?: CacheCommand;
}

const home = (rel: string): CacheWhere => ({ base: 'home', rel });
const local = (rel: string): CacheWhere => ({ base: 'localAppData', rel });

export const CACHE_CATALOG: readonly CacheCatalogEntry[] = [
  {
    id: 'npm',
    label: 'npm cache',
    paths: {
      linux: home('.npm/_cacache'),
      macos: home('.npm/_cacache'),
      windows: local('npm-cache\\_cacache'),
    },
    command: { tool: 'npm', args: ['cache', 'clean', '--force'] },
  },
  {
    id: 'pnpm',
    label: 'pnpm store',
    paths: {
      linux: home('.local/share/pnpm/store'),
      macos: home('Library/pnpm/store'),
      windows: local('pnpm\\store'),
    },
    command: { tool: 'pnpm', args: ['store', 'prune'] },
  },
  {
    id: 'yarn',
    label: 'Yarn cache',
    paths: {
      linux: home('.cache/yarn'),
      macos: home('Library/Caches/Yarn'),
      windows: local('Yarn\\Cache'),
    },
    command: { tool: 'yarn', args: ['cache', 'clean'] },
  },
  {
    id: 'pip',
    label: 'pip cache',
    paths: {
      linux: home('.cache/pip'),
      macos: home('Library/Caches/pip'),
      windows: local('pip\\Cache'),
    },
    command: { tool: 'pip', args: ['cache', 'purge'] },
  },
  {
    id: 'gradle',
    label: 'Gradle caches',
    paths: {
      linux: home('.gradle/caches'),
      macos: home('.gradle/caches'),
      windows: home('.gradle\\caches'),
    },
  },
  {
    id: 'maven',
    label: 'Maven repository',
    paths: {
      linux: home('.m2/repository'),
      macos: home('.m2/repository'),
      windows: home('.m2\\repository'),
    },
  },
  {
    id: 'nuget',
    label: 'NuGet packages',
    paths: {
      linux: home('.nuget/packages'),
      macos: home('.nuget/packages'),
      windows: home('.nuget\\packages'),
    },
    command: { tool: 'dotnet', args: ['nuget', 'locals', 'global-packages', '--clear'] },
  },
  {
    id: 'go',
    label: 'Go build cache',
    paths: {
      linux: home('.cache/go-build'),
      macos: home('Library/Caches/go-build'),
      windows: local('go-build'),
    },
    command: { tool: 'go', args: ['clean', '-cache'] },
  },
  {
    id: 'cargo',
    label: 'Cargo registry',
    paths: {
      linux: home('.cargo/registry'),
      macos: home('.cargo/registry'),
      windows: home('.cargo\\registry'),
    },
  },
];

export interface CacheEntryForOs extends CacheWhere {
  id: CacheId;
  label: string;
  command?: CacheCommand;
}

export function cacheEntriesFor(os: RunnerCleanupOs): CacheEntryForOs[] {
  return CACHE_CATALOG.map((entry) => ({
    id: entry.id,
    label: entry.label,
    ...entry.paths[os],
    ...(entry.command ? { command: entry.command } : {}),
  }));
}

export function isCacheId(value: string): value is CacheId {
  return CACHE_CATALOG.some((entry) => entry.id === value);
}

export function cacheLabel(id: CacheId): string {
  return CACHE_CATALOG.find((entry) => entry.id === id)?.label ?? id;
}

/** The tools the scan looks for on PATH, so it knows which caches a command can clean. */
export const CACHE_TOOLS: readonly string[] = [
  ...new Set(CACHE_CATALOG.flatMap((entry) => (entry.command ? [entry.command.tool] : []))),
];
