import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type {
  PackageInfo,
  PackageUpdateItemResult,
  PackageUpdateRequest,
  PackageUpdateResult,
} from '../../shared/apiTypes';
import {
  type InventoryEcosystem,
  type InventoryPackage,
  tidyInventory,
} from '../../shared/dependencyAlerts';
import { mapWithConcurrency } from './execUtils';
import type { UpdateProgressTick } from './types';

/** What the Python, Rust, Gradle and Swift adapters have in common. */

const MAX_SCAN_DEPTH = 4;
const REGISTRY_TIMEOUT_MS = 15000;
const REGISTRY_CONCURRENCY = 6;
/** Packages that must fail on the network, after their retry, before a host is given up on. */
const DEAD_HOST_FAILURES = 3;

/** Build output, installed dependencies and tool caches, all full of manifests that are not ours. */
const PRUNED_DIRS = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  // Python
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
  '.tox',
  '.nox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.eggs',
  // Rust
  'target',
  'vendor',
  // Gradle
  '.gradle',
  // Apple
  'Pods',
  'Carthage',
  'DerivedData',
  '.build',
  '.swiftpm',
  // Flutter copies of plugins, which carry Android and iOS manifests of their own
  '.dart_tool',
  '.symlinks',
  '.plugin_symlinks',
  'ephemeral',
]);

/** Every file under `dir` that `isManifest` accepts, leaving the folders above out of it. */
export async function findManifests(
  dir: string,
  isManifest: (fileName: string, folder: string) => boolean,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && isManifest(entry.name, dir)) found.push(join(dir, entry.name));
    else if (entry.isDirectory() && !PRUNED_DIRS.has(entry.name)) {
      found.push(...(await findManifests(join(dir, entry.name), isManifest, depth + 1)));
    }
  }
  return found;
}

export async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/** The nearest copy of a file from `dir` up to `root`: a workspace keeps its lock at the top. */
export async function findUpward(
  dir: string,
  root: string,
  fileName: string,
): Promise<{ path: string; source: string } | null> {
  let current = dir;
  for (;;) {
    const path = join(current, fileName);
    const source = await readFileSafe(path);
    if (source !== null) return { path, source };
    const parent = dirname(current);
    if (current === root || parent === current || relative(root, parent).startsWith('..')) {
      return null;
    }
    current = parent;
  }
}

/** A sub-project's name when it has one, else its folder, else the name of the project itself. */
export function projectLabel(root: string, dir: string, name?: string | null): string {
  return name || relative(root, dir) || basename(root);
}

/** Tracks network failures per host across one scan. */
export class HostHealth {
  private readonly failures = new Map<string, number>();

  isDead(host: string): boolean {
    return (this.failures.get(host) ?? 0) >= DEAD_HOST_FAILURES;
  }

  recordFailure(host: string): void {
    this.failures.set(host, (this.failures.get(host) ?? 0) + 1);
  }

  failedHosts(): string[] {
    return [...this.failures.keys()];
  }
}

/**
 * The body at `url`, or null when there is none to have. A request that fails on the network is
 * tried once more, and a host that keeps failing is skipped for the rest of the scan, so an
 * unreachable registry costs a few timeouts instead of one per package.
 */
export async function fetchText(
  url: string,
  health: HostHealth,
  attempt = 0,
): Promise<string | null> {
  const host = new URL(url).origin;
  if (health.isDead(host)) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    return response.ok ? await response.text() : null;
  } catch {
    if (attempt === 0) return fetchText(url, health, attempt + 1);
    health.recordFailure(host);
    return null;
  }
}

/** A dependency as an adapter found it, before its registry has been asked. */
export interface PackageRow extends Omit<PackageInfo, 'latestVersion' | 'isOutdated'> {
  /** Null when the row is not compared with a registry at all (a git dependency, say). */
  lookup: (() => Promise<string | null>) | null;
  /** Whether the latest version counts as an update for this row. */
  behind: (latest: string) => boolean;
  /** What goes up for dependency alerts, when the row is something a registry would know. */
  inventory?: { ecosystem: InventoryEcosystem; name: string; version: string };
}

/** The rows that go up for dependency alerts. Reads nothing but the rows themselves. */
export function inventoryOf(rows: PackageRow[]): InventoryPackage[] {
  return tidyInventory(
    rows.flatMap((row) => (row.inventory ? [{ ...row.inventory, dev: row.isDev }] : [])),
  );
}

export interface CheckedPackages {
  packages: PackageInfo[];
  unresolved: number;
}

/** Asks the registries about every row, a few at a time, and sorts the result by name. */
export async function checkPackages(rows: PackageRow[]): Promise<CheckedPackages> {
  let unresolved = 0;
  const packages = await mapWithConcurrency(
    rows,
    REGISTRY_CONCURRENCY,
    async ({ lookup, behind, inventory: _inventory, ...base }): Promise<PackageInfo> => {
      if (!lookup) return { ...base, latestVersion: base.currentVersion, isOutdated: false };
      const latestVersion = await lookup();
      if (!latestVersion) {
        unresolved += 1;
        return { ...base, latestVersion: null, isOutdated: false };
      }
      return { ...base, latestVersion, isOutdated: behind(latestVersion) };
    },
  );
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { packages, unresolved };
}

/** The sentence a section shows when some latest versions are unknown, or null when none are. */
export function unresolvedNote(unresolved: number, health: HostHealth): string | null {
  if (unresolved === 0) return null;
  const count = `${unresolved} package${unresolved === 1 ? '' : 's'}`;
  const failedHosts = health.failedHosts();
  return failedHosts.length > 0
    ? `Could not reach ${failedHosts.join(', ')}, so the latest version of ${count} is unknown. Refresh to try again.`
    : `The latest version of ${count} could not be looked up.`;
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(source: string, edits: TextEdit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

export const writeManifest = writeFile;

export function failedResult(name: string, message: string): PackageUpdateItemResult {
  return { name, ok: false, message };
}

export function missingFromManifest(name: string, manifestPath: string): PackageUpdateItemResult {
  return failedResult(name, `${name} is no longer in ${basename(manifestPath)}.`);
}

/** Runs one batch per manifest and reports progress the way the Packages tab expects it. */
export async function updateByManifest(
  updates: PackageUpdateRequest[],
  onProgress: (tick: UpdateProgressTick) => void,
  apply: (
    manifestPath: string,
    group: PackageUpdateRequest[],
  ) => Promise<PackageUpdateItemResult[]>,
): Promise<PackageUpdateResult> {
  if (updates.length === 0) return { ok: true, results: [] };
  const total = updates.length;
  const groups = new Map<string, PackageUpdateRequest[]>();
  for (const update of updates) {
    groups.set(update.manifestPath, [...(groups.get(update.manifestPath) ?? []), update]);
    onProgress({ packageName: update.name, status: 'running', completed: 0, total });
  }

  let completed = 0;
  const results: PackageUpdateItemResult[] = [];
  for (const [manifestPath, group] of groups) {
    let groupResults: PackageUpdateItemResult[];
    try {
      groupResults = await apply(manifestPath, group);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The update failed.';
      groupResults = group.map((update) => failedResult(update.name, message));
    }
    completed += group.length;
    for (const result of groupResults) {
      results.push(result);
      onProgress({
        packageName: result.name,
        status: result.ok ? 'done' : 'error',
        message: result.ok ? undefined : result.message,
        completed,
        total,
      });
    }
  }
  return { ok: results.every((result) => result.ok), results };
}
