import { basename, dirname, join } from 'node:path';
import type {
  PackageManagerSection,
  PackageUpdateItemResult,
  PackageUpdateRequest,
  RuntimeSource,
  RuntimeUpdateRequest,
  RuntimeUpdateResult,
} from '../../shared/apiTypes';
import {
  applyEdits,
  checkPackages,
  fetchText,
  findManifests,
  findUpward,
  HostHealth,
  inventoryOf,
  missingFromManifest,
  type PackageRow,
  projectLabel,
  readFileSafe,
  type TextEdit,
  unresolvedNote,
  updateByManifest,
  writeManifest,
} from './adapterKit';
import { CliNotFoundError, runCli } from './execUtils';
import { runtimeFeeds } from './runtimeFeeds';
import { samePrecision } from './runtimeTargets';
import {
  applyRuntimeUpdate,
  type RuntimeCandidate,
  type RuntimeUpdateDeps,
  runtimeCandidate,
} from './runtimeUpdate';
import {
  inlineHas,
  inlineString,
  lockedVersions,
  rewriteTomlString,
  scanToml,
  stringValue,
  type TomlEntry,
  type TomlString,
} from './tomlScan';
import type { PackageManagerAdapter } from './types';
import { compareLoose, isBehind, pickLatest, withPrecisionOf } from './versionText';

const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
/** `[dependencies]`, `[dev-dependencies]`, `[workspace.dependencies]`, `[target.'x'.dependencies]`. */
const DEPENDENCY_TABLE = /^(?:workspace\.|target\..+\.)?(dev-|build-)?dependencies$/;
/** The same tables with one crate spelled out: `[dependencies.tokio]`. */
const CRATE_TABLE = /^((?:workspace\.|target\..+\.)?(?:dev-|build-)?dependencies)\.([^.'"]+)$/;
const SIMPLE_REQUIREMENT = /^(\^|~|=)?\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/;
const NON_REGISTRY_FIELDS = ['path', 'git', 'workspace'];

function isManifest(fileName: string): boolean {
  return fileName === 'Cargo.toml';
}

interface CrateDependency {
  /** The name in the manifest, which a `package =` field can make different from the crate's. */
  key: string;
  crate: string;
  requirement: TomlString;
  isDev: boolean;
  /** True for a crate from a registry other than crates.io. */
  otherRegistry: boolean;
}

function fromInline(key: string, entry: TomlEntry, isDev: boolean): CrateDependency | null {
  if (NON_REGISTRY_FIELDS.some((field) => inlineHas(entry, field))) return null;
  const requirement = inlineString(entry, 'version');
  if (!requirement) return null;
  return {
    key,
    crate: inlineString(entry, 'package')?.value ?? key,
    requirement,
    isDev,
    otherRegistry: inlineHas(entry, 'registry'),
  };
}

/** Pulls together the keys of a `[dependencies.tokio]` table. */
function fromCrateTable(key: string, entries: TomlEntry[], isDev: boolean): CrateDependency | null {
  const field = (name: string) => entries.find((entry) => entry.key === name);
  if (NON_REGISTRY_FIELDS.some((name) => field(name))) return null;
  const version = field('version');
  const requirement = version ? stringValue(version) : null;
  if (!requirement) return null;
  const renamed = field('package');
  return {
    key,
    crate: (renamed && stringValue(renamed)?.value) ?? key,
    requirement,
    isDev,
    otherRegistry: field('registry') !== undefined,
  };
}

interface Manifest {
  packageName: string | null;
  dependencies: CrateDependency[];
}

function readManifest(source: string): Manifest {
  const entries = scanToml(source);
  const dependencies: CrateDependency[] = [];
  const crateTables = new Map<string, { key: string; isDev: boolean; entries: TomlEntry[] }>();
  let packageName: string | null = null;

  for (const entry of entries) {
    if (entry.table === 'package' && entry.key === 'name') {
      packageName = stringValue(entry)?.value ?? null;
    }
    const inTable = CRATE_TABLE.exec(entry.table);
    if (inTable) {
      const id = `${entry.table}#${entry.tableIndex}`;
      const table = crateTables.get(id) ?? {
        key: inTable[2],
        isDev: inTable[1].includes('dev-dependencies'),
        entries: [],
      };
      table.entries.push(entry);
      crateTables.set(id, table);
      continue;
    }
    const table = DEPENDENCY_TABLE.exec(entry.table);
    if (!table || entry.key.includes('.')) continue;
    const isDev = table[1] === 'dev-';
    const requirement = stringValue(entry);
    if (requirement) {
      dependencies.push({
        key: entry.key,
        crate: entry.key,
        requirement,
        isDev,
        otherRegistry: false,
      });
    } else {
      const dep = fromInline(entry.key, entry, isDev);
      if (dep) dependencies.push(dep);
    }
  }
  for (const { key, isDev, entries: fields } of crateTables.values()) {
    const dep = fromCrateTable(key, fields, isDev);
    if (dep) dependencies.push(dep);
  }
  return { packageName, dependencies };
}

/** Where the sparse index keeps a crate: by the first letters of its lowercased name. */
export function crateIndexPath(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length <= 2) return `${lower.length}/${lower}`;
  if (lower.length === 3) return `3/${lower[0]}/${lower}`;
  return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

/** The sparse index needs no API token and is what cargo itself reads. */
async function latestOnCratesIo(
  crate: string,
  current: string,
  health: HostHealth,
): Promise<string | null> {
  const body = await fetchText(`https://index.crates.io/${crateIndexPath(crate)}`, health);
  if (!body) return null;
  const versions: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const release = JSON.parse(line) as { vers?: string; yanked?: boolean };
      if (release.vers && !release.yanked) versions.push(release.vers);
    } catch {
      // One bad line should not cost the rest of the crate's versions.
    }
  }
  return pickLatest(versions, current);
}

/** A lock can hold several versions of one crate; this is the one this requirement resolved to. */
function lockedFor(versions: string[] | undefined, lower: string | null): string | null {
  if (!versions || versions.length === 0) return null;
  const sorted = [...versions].sort(compareLoose);
  return (
    (lower && sorted.find((version) => compareLoose(version, lower) >= 0)) ?? sorted.at(-1) ?? null
  );
}

function identity(name: string): string {
  return name;
}

async function scanManifest(
  root: string,
  manifestPath: string,
  health: HostHealth,
): Promise<PackageRow[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) return [];
  const dir = dirname(manifestPath);
  const manifest = readManifest(source);
  const label = projectLabel(root, dir, manifest.packageName);
  const lockFile = await findUpward(dir, root, 'Cargo.lock');
  const locked = lockFile ? lockedVersions(lockFile.source, identity) : new Map<string, string[]>();

  const rows = new Map<string, PackageRow>();
  for (const dep of manifest.dependencies) {
    const simple = SIMPLE_REQUIREMENT.exec(dep.requirement.value.trim());
    const lower = simple?.[2] ?? null;
    const resolved = lockedFor(locked.get(dep.crate), lower);
    const existing = rows.get(dep.key);
    if (existing) {
      existing.isDev = existing.isDev && dep.isDev;
      continue;
    }
    rows.set(dep.key, {
      name: dep.key,
      currentVersion: resolved ?? dep.requirement.value,
      isDev: dep.isDev,
      isInstalled: resolved !== null,
      manifestPath,
      projectLabel: label,
      lookup:
        simple && !dep.otherRegistry
          ? () => latestOnCratesIo(dep.crate, resolved ?? lower ?? '0', health)
          : null,
      behind: (latest) => isBehind(resolved, lower, latest),
      inventory:
        simple && !dep.otherRegistry
          ? { ecosystem: 'crates', name: dep.crate, version: resolved ?? lower ?? '0' }
          : undefined,
    });
  }
  return [...rows.values()];
}

const RUST_RELEASE = /^\d+\.\d+(?:\.\d+)?$/;

interface RustTarget {
  source: RuntimeSource;
  declared: string;
  rewrite: (text: string, value: string) => string | null;
}

function tomlTargets(source: string): RustTarget[] {
  const targets: RustTarget[] = [];
  for (const entry of scanToml(source)) {
    const value = stringValue(entry)?.value;
    if (!value || !RUST_RELEASE.test(value)) continue;
    const { table, key } = entry;
    const rewrite = (text: string, next: string) => rewriteTomlString(text, table, key, next);
    if ((table === 'package' || table === 'workspace.package') && key === 'rust-version') {
      targets.push({ source: 'rust-version', declared: value, rewrite });
    } else if (table === 'toolchain' && key === 'channel') {
      targets.push({ source: 'rust-toolchain', declared: value, rewrite });
    }
  }
  return targets;
}

function targetsInFile(path: string, source: string): RustTarget[] {
  if (basename(path) !== 'rust-toolchain' || source.includes('[toolchain]')) {
    return tomlTargets(source);
  }
  const declared = source.trim();
  if (!RUST_RELEASE.test(declared)) return [];
  return [
    {
      source: 'rust-toolchain',
      declared,
      rewrite: (text, value) => text.replace(declared, value),
    },
  ];
}

async function candidatesInFile(
  path: string,
  source: string,
  label: string,
): Promise<RuntimeCandidate[]> {
  const targets = targetsInFile(path, source);
  if (targets.length === 0) return [];
  const latestVersion = await runtimeFeeds.rust();
  return targets.map(({ source: where, declared, rewrite }) =>
    runtimeCandidate({
      kind: 'rust',
      source: where,
      declared,
      currentVersion: declared,
      latestVersion,
      next: (latest) => samePrecision(latest, declared),
      requires: null,
      manifestPath: path,
      projectLabel: label,
      rewrite,
    }),
  );
}

/** What each Cargo.toml names, and the toolchain file pinned beside it. */
async function runtimesOf(root: string, manifests: string[]): Promise<RuntimeCandidate[]> {
  const found = await Promise.all(
    manifests.map(async (manifestPath) => {
      const dir = dirname(manifestPath);
      const source = await readFileSafe(manifestPath);
      const name = source === null ? null : readManifest(source).packageName;
      const label = projectLabel(root, dir, name);
      const files = [manifestPath, join(dir, 'rust-toolchain.toml'), join(dir, 'rust-toolchain')];
      return Promise.all(
        files.map(async (file) => {
          const text = await readFileSafe(file);
          return text === null ? [] : candidatesInFile(file, text, label);
        }),
      );
    }),
  );
  return found.flat(2);
}

async function listPackages(folderPath: string): Promise<PackageManagerSection[]> {
  const manifests = await findManifests(folderPath, isManifest);
  const health = new HostHealth();
  const rows = (
    await Promise.all(manifests.map((path) => scanManifest(folderPath, path, health)))
  ).flat();
  const runtimes = (await runtimesOf(folderPath, manifests)).map((one) => one.target);
  if (rows.length === 0 && runtimes.length === 0) return [];
  const { packages, unresolved } = await checkPackages(rows);
  return [
    {
      ecosystem: 'rust',
      manager: 'cargo',
      status: 'ok',
      message: unresolvedNote(unresolved, health),
      packages,
      runtimes,
      toolchain: null,
    },
  ];
}

function nextRequirement(written: string, target: string): string | null {
  const match = SIMPLE_REQUIREMENT.exec(written.trim());
  if (!match) return null;
  const [, operator = '', version] = match;
  return `${operator}${operator === '=' ? target : withPrecisionOf(target, version)}`;
}

function cargoFailure(code: number, stdout: string, stderr: string): string {
  return (stderr || stdout).slice(-500) || `cargo exited with code ${code}`;
}

/**
 * A new requirement is written into Cargo.toml, and `cargo update --workspace` then brings the
 * lock in line without moving anything else. When the requirement already allows the new version
 * the manifest stays as it is, and only that crate's locked version is moved.
 */
async function applyToManifest(
  root: string,
  manifestPath: string,
  group: PackageUpdateRequest[],
): Promise<PackageUpdateItemResult[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) throw new Error(`Failed to read ${manifestPath}.`);
  const dir = dirname(manifestPath);
  const { dependencies } = readManifest(source);
  const lockFile = await findUpward(dir, root, 'Cargo.lock');
  const locked = lockFile ? lockedVersions(lockFile.source, identity) : new Map<string, string[]>();

  const edits: TextEdit[] = [];
  const results = new Map<string, PackageUpdateItemResult>();
  const rewritten: string[] = [];
  const lockOnly: { name: string; args: string[] }[] = [];

  for (const update of group) {
    const matching = dependencies.filter((dep) => dep.key === update.name);
    if (matching.length === 0) {
      results.set(update.name, missingFromManifest(update.name, manifestPath));
      continue;
    }
    let changed = false;
    for (const dep of matching) {
      const next = nextRequirement(dep.requirement.value, update.targetVersion);
      if (next !== null && next !== dep.requirement.value) {
        edits.push({ start: dep.requirement.start, end: dep.requirement.end, text: next });
        changed = true;
      }
    }
    results.set(update.name, { name: update.name, ok: true, message: 'Updated' });
    const dep = matching[0];
    if (changed) {
      rewritten.push(update.name);
    } else {
      const lower = SIMPLE_REQUIREMENT.exec(dep.requirement.value.trim())?.[2] ?? null;
      const resolved = lockedFor(locked.get(dep.crate), lower);
      if (resolved) {
        lockOnly.push({
          name: update.name,
          args: ['update', '-p', `${dep.crate}@${resolved}`, '--precise', update.targetVersion],
        });
      }
    }
  }

  if (edits.length > 0) await writeManifest(manifestPath, applyEdits(source, edits), 'utf-8');

  async function run(args: string[], names: string[], notFound: string): Promise<void> {
    const fail = (message: string) => {
      for (const name of names) results.set(name, { name, ok: false, message });
    };
    try {
      const { code, stdout, stderr } = await runCli('cargo', args, dir, UPDATE_TIMEOUT_MS);
      if (code !== 0) fail(cargoFailure(code, stdout, stderr));
    } catch (err) {
      if (err instanceof CliNotFoundError) fail(notFound);
      else fail(err instanceof Error ? err.message : 'cargo update failed.');
    }
  }

  if (lockFile && rewritten.length > 0) {
    await run(
      ['update', '--workspace'],
      rewritten,
      `Updated ${basename(manifestPath)}, but cargo is not on PATH, so Cargo.lock was not refreshed.`,
    );
  }
  for (const { name, args } of lockOnly) {
    await run(args, [name], 'Install Rust and add cargo to PATH to update these packages.');
  }

  return group.map((update) => results.get(update.name) as PackageUpdateItemResult);
}

export const rustAdapter: PackageManagerAdapter = {
  ecosystem: 'rust',
  async detect(folderPath) {
    return (await findManifests(folderPath, isManifest)).length > 0;
  },
  async readInventory(folderPath) {
    const manifests = await findManifests(folderPath, isManifest);
    const health = new HostHealth();
    const rows = await Promise.all(manifests.map((path) => scanManifest(folderPath, path, health)));
    return inventoryOf(rows.flat());
  },
  listPackages,
  updatePackages(folderPath, updates, onProgress) {
    return updateByManifest(updates, onProgress, (manifestPath, group) =>
      applyToManifest(folderPath, manifestPath, group),
    );
  },
  async updateRuntime(
    _folderPath: string,
    request: RuntimeUpdateRequest,
    deps: RuntimeUpdateDeps,
  ): Promise<RuntimeUpdateResult> {
    const source = await readFileSafe(request.manifestPath);
    if (source === null) return { ok: false, message: `Failed to read ${request.manifestPath}.` };
    return applyRuntimeUpdate(
      request,
      await candidatesInFile(request.manifestPath, source, ''),
      deps,
    );
  },
};
