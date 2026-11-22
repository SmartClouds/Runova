import { writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { applyEdits, findUpward, type TextEdit } from '../packageManagers/adapterKit';
import { CliNotFoundError, runCli } from '../packageManagers/execUtils';
import { scanToml, stringValue } from '../packageManagers/tomlScan';

const METADATA_TIMEOUT_MS = 60 * 1000;

/** Name to version of every crate in a Cargo workspace, read from the manifests themselves. */
export type CrateVersions = Map<string, string>;

export interface LockSyncResult {
  /** Repo-relative lockfiles that were rewritten. */
  updated: string[];
  /** Lockfiles that could not be checked, said in a way the user can act on. */
  warnings: string[];
}

interface CargoMetadata {
  packages?: { name?: unknown; version?: unknown; source?: unknown }[];
}

/**
 * `cargo metadata --no-deps` answers from the manifests alone: it needs no registry and no
 * network, and it does not write Cargo.lock. `version.workspace = true` comes back resolved.
 */
export async function readWorkspaceCrates(dir: string): Promise<CrateVersions> {
  const { code, stdout, stderr } = await runCli(
    'cargo',
    ['metadata', '--no-deps', '--offline', '--format-version', '1'],
    dir,
    METADATA_TIMEOUT_MS,
  );
  if (code !== 0) {
    throw new Error((stderr || stdout).trim().slice(-500) || `cargo exited with code ${code}`);
  }
  const metadata = JSON.parse(stdout) as CargoMetadata;
  const crates: CrateVersions = new Map();
  for (const pkg of metadata.packages ?? []) {
    if (pkg.source != null) continue;
    if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
      crates.set(pkg.name, pkg.version);
    }
  }
  return crates;
}

/**
 * Cargo.lock with the version of each local crate set to what its manifest says now. Only the
 * `[[package]]` entries without a `source` are local; registry and git crates that happen to
 * share a name are left as they are, and so is everything else in the file.
 */
export function alignCargoLock(source: string, crates: CrateVersions): string {
  const packages = new Map<
    number,
    { name?: string; version?: { value: string; start: number; end: number }; remote: boolean }
  >();
  for (const entry of scanToml(source)) {
    if (entry.table !== 'package') continue;
    const row = packages.get(entry.tableIndex) ?? { remote: false };
    if (entry.key === 'name') row.name = stringValue(entry)?.value;
    else if (entry.key === 'version') row.version = stringValue(entry) ?? undefined;
    else if (entry.key === 'source') row.remote = true;
    packages.set(entry.tableIndex, row);
  }

  const edits: TextEdit[] = [];
  for (const { name, version, remote } of packages.values()) {
    if (remote || !name || !version) continue;
    const wanted = crates.get(name);
    if (wanted && wanted !== version.value) {
      edits.push({ start: version.start, end: version.end, text: wanted });
    }
  }
  return edits.length > 0 ? applyEdits(source, edits) : source;
}

/**
 * A version bump edits Cargo.toml, but Cargo.lock records every workspace crate's own version
 * too, and `cargo build --locked` (what CI runs) refuses a lock that no longer matches. The
 * agent CLI is told to leave lockfiles alone, so each lock that sits above a changed Cargo.toml
 * is brought in line here, touching only the version lines of the workspace's own crates.
 */
export async function syncCargoLocks(
  root: string,
  changedPaths: string[],
  readCrates: (dir: string) => Promise<CrateVersions> = readWorkspaceCrates,
): Promise<LockSyncResult> {
  const locks = new Map<string, string>();
  for (const path of changedPaths) {
    if (path.split('/').pop() !== 'Cargo.toml') continue;
    const lock = await findUpward(dirname(join(root, path)), root, 'Cargo.lock');
    if (lock) locks.set(lock.path, lock.source);
  }

  const result: LockSyncResult = { updated: [], warnings: [] };
  for (const [lockPath, source] of locks) {
    const shown = relative(root, lockPath).replace(/\\/g, '/');
    let crates: CrateVersions;
    try {
      crates = await readCrates(dirname(lockPath));
    } catch (error) {
      const reason =
        error instanceof CliNotFoundError
          ? 'cargo is not on PATH'
          : `cargo metadata failed: ${error instanceof Error ? error.message : String(error)}`;
      result.warnings.push(
        `${shown} was not updated because ${reason}. Run \`cargo update --workspace --offline\` in ${dirname(shown)} before committing, or builds with --locked will fail.`,
      );
      continue;
    }
    const next = alignCargoLock(source, crates);
    if (next !== source) {
      await writeFile(lockPath, next, 'utf-8');
      result.updated.push(shown);
    }
  }
  return result;
}
