import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  PackageManagerKind,
  PackageManagerSection,
  PackageUpdateItemResult,
  PackageUpdateRequest,
  RuntimeUpdateRequest,
  RuntimeUpdateResult,
} from '../../shared/apiTypes';
import {
  applyEdits,
  checkPackages,
  fetchText,
  findManifests,
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
import type { PackageManagerAdapter } from './types';
import { compareLoose, isBehind, pickLatest, withPrecisionOf } from './versionText';

const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const SEMVER_TAG = /^v?\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isManifest(fileName: string, folder: string): boolean {
  return (
    fileName === 'Package.swift' ||
    fileName === 'Podfile' ||
    (fileName === 'project.pbxproj' && folder.endsWith('.xcodeproj'))
  );
}

function isPodfile(path: string): boolean {
  return basename(path) === 'Podfile';
}

/** A version the file states, with where it stands so it can be replaced. */
interface Declared {
  name: string;
  /** Null for a pod with no version requirement. */
  version: string | null;
  start: number;
  end: number;
  /** False for a shape an update will not rewrite, such as a range. */
  movable: boolean;
  repository: string | null;
}

// --- Swift packages ----------------------------------------------------------

function repositoryName(url: string): string {
  return (url.split(/[/:]/).at(-1) ?? url).replace(/\.git$/i, '');
}

/** Blanks whole-line comments, keeping every offset. A `//` inside a URL is left alone. */
function maskLineComments(source: string): string {
  return source.replace(/^[ \t]*\/\/.*$/gm, (comment) => ' '.repeat(comment.length));
}

const PACKAGE_CALL = /\.package\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const PACKAGE_RANGE = /"([^"]+)"\s*\.\.[.<]\s*"[^"]+"/;
const PACKAGE_VERSION = /(?:\bfrom|\bexact)\s*:\s*"([^"]+)"|\.exact\(\s*"([^"]+)"\s*\)/;

function readPackageSwift(source: string): Declared[] {
  const found: Declared[] = [];
  for (const call of maskLineComments(source).matchAll(PACKAGE_CALL)) {
    const args = call[1];
    const url = /\burl\s*:\s*"([^"]+)"/.exec(args)?.[1];
    if (!url) continue;
    const argsStart = call.index + call[0].indexOf(args);
    const base = { name: repositoryName(url), repository: url };
    const range = PACKAGE_RANGE.exec(args);
    const version = range ? null : PACKAGE_VERSION.exec(args);
    if (range) {
      const start = argsStart + range.index + 1;
      found.push({
        ...base,
        version: range[1],
        start,
        end: start + range[1].length,
        movable: false,
      });
    } else if (version) {
      const text = version[1] ?? version[2];
      const start = argsStart + version.index + version[0].lastIndexOf(text);
      found.push({ ...base, version: text, start, end: start + text.length, movable: true });
    }
  }
  return found;
}

const PBX_REFERENCE =
  /isa = XCRemoteSwiftPackageReference;\s*repositoryURL = "?([^";\n]+)"?;\s*requirement = \{([\s\S]*?)\};/g;

function readPbxproj(source: string): Declared[] {
  const found: Declared[] = [];
  for (const reference of source.matchAll(PBX_REFERENCE)) {
    const [whole, url, body] = reference;
    const kind = /kind = (\w+);/.exec(body)?.[1];
    if (kind === 'branch' || kind === 'revision') continue;
    const version = /\b(?:minimumVersion|version) = "?([^";\s]+)"?;/.exec(body);
    if (!version) continue;
    const bodyStart = reference.index + whole.lastIndexOf(body);
    const start = bodyStart + version.index + version[0].indexOf(version[1]);
    found.push({
      name: repositoryName(url),
      repository: url,
      version: version[1],
      start,
      end: start + version[1].length,
      movable: kind !== 'versionRange',
    });
  }
  return found;
}

async function resolvedFiles(manifestPath: string): Promise<string[]> {
  const dir = dirname(manifestPath);
  if (basename(manifestPath) === 'Package.swift') return [join(dir, 'Package.resolved')];
  const swiftpm = join('xcshareddata', 'swiftpm', 'Package.resolved');
  const files = [join(dir, 'project.xcworkspace', swiftpm)];
  const siblings = await readdir(dirname(dir)).catch(() => [] as string[]);
  for (const name of siblings) {
    if (name.endsWith('.xcworkspace')) files.push(join(dirname(dir), name, swiftpm));
  }
  return files;
}

interface ResolvedPin {
  identity?: string;
  package?: string;
  location?: string;
  repositoryURL?: string;
  state?: { version?: string | null };
}

/** Versions SwiftPM resolved, by lowercased package name, from either file layout. */
async function readResolved(manifestPath: string): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  for (const file of await resolvedFiles(manifestPath)) {
    const source = await readFileSafe(file);
    if (source === null) continue;
    let pins: ResolvedPin[];
    try {
      const data = JSON.parse(source) as {
        pins?: ResolvedPin[];
        object?: { pins?: ResolvedPin[] };
      };
      pins = data.pins ?? data.object?.pins ?? [];
    } catch {
      continue;
    }
    for (const pin of pins) {
      const url = pin.location ?? pin.repositoryURL;
      const name = url ? repositoryName(url) : (pin.identity ?? pin.package);
      if (name && pin.state?.version) resolved.set(name.toLowerCase(), pin.state.version);
    }
  }
  return resolved;
}

/** Only https is asked: these addresses come from the project, and scp-style ones map onto it. */
function httpsRepository(url: string): string | null {
  const scp = /^git@([^:/]+):(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return /^https:\/\//i.test(url) ? url : null;
}

/**
 * The repository's tags, from the ref list every git host serves over plain HTTP. This asks no API
 * with a rate limit and needs no git on the machine, and it never runs anything the project chose.
 */
async function latestTag(
  repository: string,
  current: string,
  health: HostHealth,
): Promise<string | null> {
  const url = httpsRepository(repository);
  if (!url) return null;
  const body = await fetchText(`${url}/info/refs?service=git-upload-pack`, health).catch(
    () => null,
  );
  if (!body) return null;
  const tags = new Set<string>();
  for (const match of body.matchAll(/refs\/tags\/([^\s^\0]+)/g)) {
    if (SEMVER_TAG.test(match[1])) tags.add(match[1].replace(/^v/, ''));
  }
  return pickLatest([...tags], current);
}

/** `github.com/owner/repo`, the form the advisory database names a Swift package by. */
function repositoryAddress(url: string): string | null {
  return (
    httpsRepository(url)
      ?.replace(/^https:\/\//i, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '') ?? null
  );
}

/** A lock that fell behind a newer manifest says less than the manifest does. */
function currentOf(
  locked: string | null,
  declared: string | null,
): { version: string; fromLock: boolean } | null {
  if (locked && (!declared || compareLoose(locked, declared) >= 0)) {
    return { version: locked, fromLock: true };
  }
  return declared ? { version: declared, fromLock: false } : null;
}

async function scanSwiftManifest(
  root: string,
  manifestPath: string,
  health: HostHealth,
): Promise<PackageRow[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) return [];
  const isPackageSwift = basename(manifestPath) === 'Package.swift';
  const declared = isPackageSwift ? readPackageSwift(source) : readPbxproj(source);
  const resolved = await readResolved(manifestPath);
  const folder = dirname(manifestPath);
  const label = isPackageSwift
    ? projectLabel(root, folder)
    : basename(folder).replace(/\.xcodeproj$/, '');

  return declared.flatMap((dep) => {
    const locked = resolved.get(dep.name.toLowerCase()) ?? null;
    const current = currentOf(locked, dep.version);
    if (!current || !dep.repository) return [];
    const repository = dep.repository;
    return [
      {
        name: dep.name,
        currentVersion: current.version,
        isDev: false,
        isInstalled: current.fromLock,
        manifestPath,
        projectLabel: label,
        lookup: dep.movable ? () => latestTag(repository, current.version, health) : null,
        behind: (latest: string) => isBehind(locked, dep.version, latest),
        inventory: repositoryAddress(repository)
          ? {
              ecosystem: 'swift' as const,
              name: repositoryAddress(repository) as string,
              version: current.version,
            }
          : undefined,
      } satisfies PackageRow,
    ];
  });
}

// --- CocoaPods ---------------------------------------------------------------

const POD_LINE = /^(\s*pod\s+(['"]))([^'"]+)\2(.*)$/;
const POD_REQUIREMENT = /^\s*,\s*(['"])([^'"]+)\1/;
const POD_SOURCE_OPTION = /:(?:path|git|podspec)\b|\b(?:path|git|podspec):/;
const POD_VERSION = /^(~>|>=|<=|>|<|=)?\s*(\d.*)$/;

function readPodfile(source: string): Declared[] {
  const found: Declared[] = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const match = POD_LINE.exec(line.replace(/\r$/, ''));
    if (!match) continue;
    const [, lead, , name, rest] = match;
    if (POD_SOURCE_OPTION.test(rest)) continue;
    const requirement = POD_REQUIREMENT.exec(rest);
    const base = { name, repository: null, movable: true };
    if (requirement) {
      const start =
        lineStart +
        lead.length +
        name.length +
        1 +
        requirement.index +
        requirement[0].indexOf(requirement[2]);
      found.push({ ...base, version: requirement[2], start, end: start + requirement[2].length });
    } else {
      found.push({ ...base, version: null, start: 0, end: 0 });
    }
  }
  return found;
}

function readPodfileLock(source: string): Map<string, string> {
  const locked = new Map<string, string>();
  const pods = /^PODS:\r?\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(source)?.[1] ?? '';
  for (const match of pods.matchAll(/^ {2}- "?([^\s"(]+) \(([^)]+)\)/gm)) {
    locked.set(match[1], match[2]);
  }
  return locked;
}

function podRoot(name: string): string {
  return name.split('/')[0];
}

/** The CDN CocoaPods itself reads, split into files by the hash of the pod's name. */
async function latestPod(
  name: string,
  current: string,
  health: HostHealth,
): Promise<string | null> {
  const root = podRoot(name);
  const hash = createHash('md5').update(root).digest('hex');
  const body = await fetchText(
    `https://cdn.cocoapods.org/all_pods_versions_${hash[0]}_${hash[1]}_${hash[2]}.txt`,
    health,
  );
  if (!body) return null;
  const line = body.split('\n').find((candidate) => candidate.startsWith(`${root}/`));
  return line ? pickLatest(line.trim().split('/').slice(1), current) : null;
}

/** The plain version a Podfile requirement starts from, when it has one. */
function podLowerBound(requirement: string | null): string | null {
  if (!requirement) return null;
  const match = POD_VERSION.exec(requirement.trim());
  return match && match[1] !== '<' && match[1] !== '<=' ? match[2].trim() : null;
}

async function scanPodfile(
  root: string,
  manifestPath: string,
  health: HostHealth,
): Promise<PackageRow[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) return [];
  const folder = dirname(manifestPath);
  const lockSource = await readFileSafe(join(folder, 'Podfile.lock'));
  const locked = lockSource ? readPodfileLock(lockSource) : new Map<string, string>();
  const label = projectLabel(root, folder);

  return readPodfile(source).map((pod) => {
    const lockedVersion = locked.get(pod.name) ?? null;
    const lower = podLowerBound(pod.version);
    const current = currentOf(lockedVersion, lower);
    return {
      name: pod.name,
      currentVersion: current?.version ?? pod.version ?? 'any',
      isDev: false,
      isInstalled: lockedVersion !== null,
      manifestPath,
      projectLabel: label,
      lookup: current ? () => latestPod(pod.name, current.version, health) : null,
      behind: (latest: string) => isBehind(lockedVersion, lower, latest),
      inventory: current
        ? { ecosystem: 'pods' as const, name: podRoot(pod.name), version: current.version }
        : undefined,
    };
  });
}

// --- Swift versions ----------------------------------------------------------

const TOOLS_VERSION = /^\s*\/\/\s*swift-tools-version\s*:\s*(\d+(?:\.\d+){1,2})/;
const LANGUAGE_VERSION = /\bSWIFT_VERSION = "?(\d+(?:\.\d+)?)"?;/;

async function candidatesInFile(
  path: string,
  source: string,
  label: string,
): Promise<RuntimeCandidate[]> {
  const common = {
    kind: 'swift' as const,
    requires: null,
    manifestPath: path,
    projectLabel: label,
  };
  if (basename(path) === 'Package.swift') {
    const declared = TOOLS_VERSION.exec(source)?.[1];
    if (!declared) return [];
    return [
      runtimeCandidate({
        ...common,
        source: 'swift-tools',
        declared,
        currentVersion: declared,
        latestVersion: await runtimeFeeds.swift(),
        next: (latest) => samePrecision(latest, declared),
        rewrite: (text, value) => {
          const match = TOOLS_VERSION.exec(text);
          if (!match) return null;
          const end = match[0].length;
          return text.slice(0, end - match[1].length) + value + text.slice(end);
        },
      }),
    ];
  }
  const declared = LANGUAGE_VERSION.exec(source)?.[1];
  if (!declared) return [];
  const newest = await runtimeFeeds.swift();
  return [
    runtimeCandidate({
      ...common,
      source: 'swift-language',
      declared,
      currentVersion: declared,
      // A language mode is a major version: there has never been a Swift 6.2 mode.
      latestVersion: newest ? `${newest.split('.')[0]}.0` : null,
      next: null,
      rewrite: () => null,
    }),
  ];
}

function swiftLabel(root: string, manifestPath: string): string {
  const folder = dirname(manifestPath);
  return basename(manifestPath) === 'Package.swift'
    ? projectLabel(root, folder)
    : basename(folder).replace(/\.xcodeproj$/, '');
}

async function swiftRuntimes(root: string, manifests: string[]): Promise<RuntimeCandidate[]> {
  const found = await Promise.all(
    manifests.map(async (path) => {
      const source = await readFileSafe(path);
      return source === null ? [] : candidatesInFile(path, source, swiftLabel(root, path));
    }),
  );
  return found.flat();
}

// --- Listing -----------------------------------------------------------------

async function section(
  manager: Extract<PackageManagerKind, 'spm' | 'cocoapods'>,
  rows: PackageRow[],
  runtimes: RuntimeCandidate[],
  health: HostHealth,
): Promise<PackageManagerSection[]> {
  if (rows.length === 0 && runtimes.length === 0) return [];
  const { packages, unresolved } = await checkPackages(rows);
  return [
    {
      ecosystem: 'swift',
      manager,
      status: 'ok',
      message: unresolvedNote(unresolved, health),
      packages,
      runtimes: runtimes.map((one) => one.target),
      toolchain: null,
    },
  ];
}

async function listPackages(folderPath: string): Promise<PackageManagerSection[]> {
  const manifests = await findManifests(folderPath, isManifest);
  const health = new HostHealth();
  const swiftManifests = manifests.filter((path) => !isPodfile(path));
  const swift = await Promise.all(
    swiftManifests.map((path) => scanSwiftManifest(folderPath, path, health)),
  );
  const pods = await Promise.all(
    manifests.filter(isPodfile).map((path) => scanPodfile(folderPath, path, health)),
  );
  return [
    ...(await section(
      'spm',
      swift.flat(),
      await swiftRuntimes(folderPath, swiftManifests),
      health,
    )),
    ...(await section('cocoapods', pods.flat(), [], health)),
  ];
}

// --- Updating ----------------------------------------------------------------

/** Xcode and SwiftPM notice a changed requirement and resolve it again on their own. */
async function updateSwiftManifest(
  manifestPath: string,
  group: PackageUpdateRequest[],
): Promise<PackageUpdateItemResult[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) throw new Error(`Failed to read ${manifestPath}.`);
  const declared =
    basename(manifestPath) === 'Package.swift' ? readPackageSwift(source) : readPbxproj(source);
  const edits: TextEdit[] = [];
  const results = group.map((update) => {
    const dep = declared.find(
      (one) => one.movable && one.name.toLowerCase() === update.name.toLowerCase(),
    );
    if (!dep) return missingFromManifest(update.name, manifestPath);
    edits.push({ start: dep.start, end: dep.end, text: update.targetVersion });
    return { name: update.name, ok: true, message: 'Updated' };
  });
  if (edits.length > 0) await writeManifest(manifestPath, applyEdits(source, edits), 'utf-8');
  return results;
}

function nextPodRequirement(written: string, target: string): string {
  const match = POD_VERSION.exec(written.trim());
  if (!match) return written;
  const [, operator, version] = match;
  if (!operator) return target;
  if (operator === '<' || operator === '<=') return written;
  const value = operator === '=' ? target : withPrecisionOf(target, version.trim());
  return `${operator} ${value}`;
}

/**
 * The Podfile is the part that can always be done. CocoaPods only runs on a Mac, so where it is
 * missing a changed Podfile still counts, and the next `pod install` on the Mac finishes the job.
 */
async function updatePodfile(
  manifestPath: string,
  group: PackageUpdateRequest[],
): Promise<PackageUpdateItemResult[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) throw new Error(`Failed to read ${manifestPath}.`);
  const declared = readPodfile(source);
  const edits: TextEdit[] = [];
  const changed = new Set<string>();
  const results = new Map<string, PackageUpdateItemResult>();
  const roots: string[] = [];

  for (const update of group) {
    const pod = declared.find((one) => one.name === update.name);
    if (!pod) {
      results.set(update.name, missingFromManifest(update.name, manifestPath));
      continue;
    }
    if (pod.version) {
      const next = nextPodRequirement(pod.version, update.targetVersion);
      if (next !== pod.version) {
        edits.push({ start: pod.start, end: pod.end, text: next });
        changed.add(update.name);
      }
    }
    results.set(update.name, { name: update.name, ok: true, message: 'Updated' });
    const root = podRoot(update.name);
    if (!roots.includes(root)) roots.push(root);
  }
  if (edits.length > 0) await writeManifest(manifestPath, applyEdits(source, edits), 'utf-8');

  if (roots.length > 0) {
    try {
      const { code, stdout, stderr } = await runCli(
        'pod',
        ['update', ...roots],
        dirname(manifestPath),
        UPDATE_TIMEOUT_MS,
      );
      if (code !== 0) {
        const tail = (stderr || stdout).slice(-500) || `pod exited with code ${code}`;
        for (const [name, result] of results) {
          if (result.ok) results.set(name, { name, ok: false, message: tail });
        }
      }
    } catch (err) {
      if (!(err instanceof CliNotFoundError)) throw err;
      for (const [name, result] of results) {
        if (!result.ok) continue;
        results.set(
          name,
          changed.has(name)
            ? {
                name,
                ok: true,
                message: 'Updated the Podfile. Run pod install on a Mac to finish.',
              }
            : {
                name,
                ok: false,
                message: 'Install CocoaPods and add it to PATH to update these pods.',
              },
        );
      }
    }
  }
  return group.map((update) => results.get(update.name) as PackageUpdateItemResult);
}

export const swiftAdapter: PackageManagerAdapter = {
  ecosystem: 'swift',
  async detect(folderPath) {
    return (await findManifests(folderPath, isManifest)).length > 0;
  },
  async readInventory(folderPath) {
    const manifests = await findManifests(folderPath, isManifest);
    const health = new HostHealth();
    const rows = await Promise.all(
      manifests.map((path) =>
        isPodfile(path)
          ? scanPodfile(folderPath, path, health)
          : scanSwiftManifest(folderPath, path, health),
      ),
    );
    return inventoryOf(rows.flat());
  },
  listPackages,
  updatePackages(_folderPath, updates, onProgress) {
    return updateByManifest(updates, onProgress, (manifestPath, group) =>
      isPodfile(manifestPath)
        ? updatePodfile(manifestPath, group)
        : updateSwiftManifest(manifestPath, group),
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
