import { basename, dirname, join, relative } from 'node:path';
import type {
  PackageManagerKind,
  PackageManagerSection,
  PackageUpdateItemResult,
  PackageUpdateRequest,
  RuntimeSource,
  RuntimeTarget,
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
import { CliNotFoundError, runCli, tryParseJson } from './execUtils';
import { runtimeFeeds } from './runtimeFeeds';
import { samePrecision } from './runtimeTargets';
import {
  applyRuntimeUpdate,
  type RuntimeCandidate,
  type RuntimeUpdateDeps,
  runtimeCandidate,
} from './runtimeUpdate';
import {
  arrayStrings,
  inlineHas,
  inlineString,
  lockedVersions,
  rewriteTomlString,
  scanToml,
  stringValue,
  type TomlEntry,
} from './tomlScan';
import type { PackageManagerAdapter } from './types';
import { compareLoose, isBehind, isPrerelease, withPrecisionOf } from './versionText';

const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
const REQUIREMENTS_FILE = /^requirements(?:[-_.][\w.-]+)?\.txt$/i;
const DEV_FILE = /(?:^|[-_.])(?:dev|test|tests|lint|ci|docs)(?:[-_.]|$)/i;
const DEV_EXTRA = /^(?:dev|test|tests|lint|typing)$/i;

type PythonManager = Extract<PackageManagerKind, 'pip' | 'uv' | 'poetry' | 'pipenv'>;
type PythonTool = Exclude<PythonManager, 'pip'>;

/** Where in pyproject.toml a dependency is, which is what the tools need told on an update. */
type DependencyGroup =
  | { kind: 'main' }
  | { kind: 'dev' }
  | { kind: 'group'; name: string }
  | { kind: 'optional'; name: string };

interface Declared {
  name: string;
  /** As written, brackets included: `[argon2]`. */
  extras: string;
  /** The version part as written, or null when there is none. */
  specifier: string | null;
  /** Where the specifier is in the file. */
  start: number;
  end: number;
  isDev: boolean;
  group: DependencyGroup;
  /** False when the file pins hashes, which a new version would no longer match. */
  rewritable: boolean;
}

/** PEP 503: names compare without case and treat runs of `-`, `_` and `.` as one. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function isManifest(fileName: string, folder: string): boolean {
  return (
    fileName === 'pyproject.toml' ||
    fileName === 'Pipfile' ||
    REQUIREMENTS_FILE.test(fileName) ||
    (basename(folder) === 'requirements' && fileName.endsWith('.txt'))
  );
}

function fileKind(path: string): 'pyproject' | 'pipfile' | 'requirements' {
  const name = basename(path);
  if (name === 'pyproject.toml') return 'pyproject';
  return name === 'Pipfile' ? 'pipfile' : 'requirements';
}

// --- Reading -----------------------------------------------------------------

const REQUIREMENT = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/s;

/** One PEP 508 requirement, with `offset` being where `text` starts in the file. */
function parseRequirement(
  text: string,
  offset: number,
  extra: Pick<Declared, 'isDev' | 'group' | 'rewritable'>,
): Declared | null {
  const match = REQUIREMENT.exec(text);
  if (!match) return null;
  const [, name, extras = '', rest] = match;
  if (rest.startsWith('@')) return null; // A direct URL has no registry version.
  const beforeMarker = rest.split(';')[0];
  const specifier = beforeMarker.trim();
  const inText = specifier ? text.indexOf(specifier, text.length - rest.length) : -1;
  return {
    name,
    extras,
    specifier: specifier || null,
    start: inText === -1 ? offset + text.length : offset + inText,
    end: inText === -1 ? offset + text.length : offset + inText + specifier.length,
    ...extra,
  };
}

function readRequirementsFile(source: string, manifestPath: string): Declared[] {
  const isDev = DEV_FILE.test(basename(manifestPath).replace(/\.txt$/i, ''));
  const declared: Declared[] = [];
  let offset = 0;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineStart = offset;
    offset += line.length + 1;

    let text = line.replace(/\r$/, '');
    let rewritable = true;
    if (/\\\s*$/.test(text)) {
      text = text.replace(/\s*\\\s*$/, '');
      // Everything continued onto the next lines is options, which is where hashes go.
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next].includes('--hash')) rewritable = false;
        if (!/\\\s*$/.test(lines[next])) break;
      }
    }
    const content = text
      .replace(/\s+#.*$/, '')
      .replace(/\s+--.*$/, '')
      .trimEnd();
    if (text.includes('--hash')) rewritable = false;
    const trimmed = content.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;

    const parsed = parseRequirement(trimmed, lineStart + (content.length - trimmed.length), {
      isDev,
      group: { kind: 'main' },
      rewritable,
    });
    if (parsed) declared.push(parsed);
  }
  return declared;
}

function arrayRequirements(entry: TomlEntry, isDev: boolean, group: DependencyGroup): Declared[] {
  return arrayStrings(entry).flatMap((one) => {
    const parsed = parseRequirement(one.value, one.start, { isDev, group, rewritable: true });
    return parsed ? [parsed] : [];
  });
}

const POETRY_GROUP = /^tool\.poetry\.group\.([^.]+)\.dependencies$/;

function poetryDependency(entry: TomlEntry, isDev: boolean, group: DependencyGroup): Declared[] {
  if (entry.key === 'python') return [];
  if (['path', 'git', 'url', 'file'].some((field) => inlineHas(entry, field))) return [];
  const value = stringValue(entry) ?? inlineString(entry, 'version');
  const extras = /extras\s*=\s*\[([^\]]*)\]/.exec(entry.text)?.[1];
  const names = extras
    ?.split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return [
    {
      name: entry.key,
      extras: names?.length ? `[${names.join(',')}]` : '',
      specifier: value?.value ?? null,
      start: value?.start ?? entry.start,
      end: value?.end ?? entry.start,
      isDev,
      group,
      rewritable: true,
    },
  ];
}

interface Pyproject {
  name: string | null;
  usesPoetry: boolean;
  usesUv: boolean;
  declared: Declared[];
}

function readPyproject(source: string): Pyproject {
  const result: Pyproject = { name: null, usesPoetry: false, usesUv: false, declared: [] };
  for (const entry of scanToml(source)) {
    const { table, key } = entry;
    if (table === 'tool.poetry' || table.startsWith('tool.poetry.')) result.usesPoetry = true;
    if (table === 'tool.uv' || table.startsWith('tool.uv.')) result.usesUv = true;
    if ((table === 'project' || table === 'tool.poetry') && key === 'name') {
      result.name = result.name ?? stringValue(entry)?.value ?? null;
    }

    const poetryGroup = POETRY_GROUP.exec(table)?.[1];
    if (table === 'project' && key === 'dependencies') {
      result.declared.push(...arrayRequirements(entry, false, { kind: 'main' }));
    } else if (table === 'project.optional-dependencies') {
      result.declared.push(
        ...arrayRequirements(entry, DEV_EXTRA.test(key), { kind: 'optional', name: key }),
      );
    } else if (table === 'dependency-groups') {
      result.declared.push(...arrayRequirements(entry, true, { kind: 'group', name: key }));
    } else if (table === 'tool.uv' && key === 'dev-dependencies') {
      result.declared.push(...arrayRequirements(entry, true, { kind: 'dev' }));
    } else if (table === 'tool.poetry.dependencies') {
      result.declared.push(...poetryDependency(entry, false, { kind: 'main' }));
    } else if (table === 'tool.poetry.dev-dependencies') {
      result.declared.push(...poetryDependency(entry, true, { kind: 'group', name: 'dev' }));
    } else if (poetryGroup) {
      result.declared.push(...poetryDependency(entry, true, { kind: 'group', name: poetryGroup }));
    }
  }
  return result;
}

function readPipfile(source: string): Declared[] {
  const declared: Declared[] = [];
  for (const entry of scanToml(source)) {
    if (entry.table !== 'packages' && entry.table !== 'dev-packages') continue;
    if (['path', 'git', 'file', 'hg', 'svn'].some((field) => inlineHas(entry, field))) continue;
    const isDev = entry.table === 'dev-packages';
    const [parsed] = poetryDependency(entry, isDev, isDev ? { kind: 'dev' } : { kind: 'main' });
    declared.push({ ...parsed, specifier: parsed.specifier === '*' ? null : parsed.specifier });
  }
  return declared;
}

/** Pipfile.lock is JSON with a `version` of `==1.2.3` per package. */
function readPipfileLock(source: string): Map<string, string[]> {
  type Section = Record<string, { version?: string }>;
  const data = tryParseJson<{ default?: Section; develop?: Section }>(source);
  const locked = new Map<string, string[]>();
  for (const [name, entry] of Object.entries({ ...data?.develop, ...data?.default })) {
    const version = entry?.version?.replace(/^==/, '');
    if (version) locked.set(normalize(name), [version]);
  }
  return locked;
}

/** The clauses that give a version to start from, in the operators each tool writes. */
const LOWER_CLAUSE = /^(===|==|~=|>=|\^|~)?\s*(\d[^\s,]*)$/;

function lowerBound(specifier: string | null): string | null {
  for (const clause of (specifier ?? '').split(',')) {
    const match = LOWER_CLAUSE.exec(clause.trim());
    if (match) return match[2].replace(/\.\*$/, '');
  }
  return null;
}

function exactVersion(specifier: string | null): string | null {
  const match = LOWER_CLAUSE.exec((specifier ?? '').trim());
  if (!match || (specifier ?? '').includes(',')) return null;
  const operator = match[1] ?? '';
  return ['', '==', '==='].includes(operator) && !match[2].endsWith('.*') ? match[2] : null;
}

// --- Listing -----------------------------------------------------------------

async function latestOnPypi(name: string, health: HostHealth): Promise<string | null> {
  const body = await fetchText(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, health);
  if (!body) return null;
  try {
    return (JSON.parse(body) as { info?: { version?: string } }).info?.version ?? null;
  } catch {
    return null;
  }
}

interface ScannedManifest {
  manager: PythonManager;
  rows: PackageRow[];
  /** Separate because it asks a release feed, which an inventory read must not. */
  runtimes: () => Promise<RuntimeCandidate[]>;
}

async function managerOf(pyproject: Pyproject, dir: string, root: string): Promise<PythonManager> {
  if (await findUpward(dir, root, 'uv.lock')) return 'uv';
  if ((await findUpward(dir, root, 'poetry.lock')) || pyproject.usesPoetry) return 'poetry';
  return pyproject.usesUv ? 'uv' : 'pip';
}

function toRow(
  dep: Declared,
  locked: string | null,
  manifestPath: string,
  label: string,
  health: HostHealth,
): PackageRow {
  const lower = lowerBound(dep.specifier);
  const exact = exactVersion(dep.specifier);
  const currentVersion = locked ?? exact ?? dep.specifier ?? 'any';
  const reference = locked ?? lower;
  const compared = dep.rewritable && reference !== null;
  const known = locked ?? exact ?? lower;
  return {
    name: dep.name,
    currentVersion,
    isDev: dep.isDev,
    isInstalled: locked !== null || exact !== null,
    manifestPath,
    projectLabel: label,
    lookup: compared ? () => latestOnPypi(dep.name, health) : null,
    behind: (latest) =>
      (!isPrerelease(latest) || isPrerelease(reference ?? '')) && isBehind(locked, lower, latest),
    inventory: known ? { ecosystem: 'pypi', name: dep.name, version: known } : undefined,
  };
}

interface PythonTarget {
  source: RuntimeSource;
  declared: string;
  currentVersion: string;
  next: (latest: string) => string;
  rewrite: (text: string, value: string) => string | null;
}

/** A Python range, moved the way a dependency's range is. */
function specifierTarget(
  source: RuntimeSource,
  declared: string,
  table: string,
  key: string,
): PythonTarget[] {
  const lower = lowerBound(declared);
  if (!lower) return [];
  return [
    {
      source,
      declared,
      currentVersion: lower,
      next: (latest) => nextSpecifier(declared, latest),
      rewrite: (text, value) => rewriteTomlString(text, table, key, value),
    },
  ];
}

function targetsInFile(path: string, source: string): PythonTarget[] {
  if (basename(path) === '.python-version') {
    const version = /^\s*(\d+\.\d+(?:\.\d+)?)\s*$/.exec(source)?.[1];
    if (!version) return [];
    return [
      {
        source: 'python-version-file',
        declared: version,
        currentVersion: version,
        next: (latest) => samePrecision(latest, version),
        rewrite: (text, value) => text.replace(version, value),
      },
    ];
  }
  const targets: PythonTarget[] = [];
  for (const entry of scanToml(source)) {
    const value = stringValue(entry)?.value;
    if (!value) continue;
    if (entry.table === 'project' && entry.key === 'requires-python') {
      targets.push(...specifierTarget('requires-python', value, entry.table, entry.key));
    } else if (entry.table === 'tool.poetry.dependencies' && entry.key === 'python') {
      targets.push(...specifierTarget('poetry-python', value, entry.table, entry.key));
    } else if (entry.table === 'requires' && entry.key === 'python_version') {
      const { table, key } = entry;
      targets.push({
        source: 'pipfile-python',
        declared: value,
        currentVersion: value,
        next: (latest) => samePrecision(latest, value),
        rewrite: (text, next) => rewriteTomlString(text, table, key, next),
      });
    }
  }
  return targets;
}

async function candidatesInFile(
  path: string,
  source: string,
  label: string,
): Promise<RuntimeCandidate[]> {
  // Only a pyproject, a Pipfile or a .python-version can name a Python version.
  const targets =
    fileKind(path) === 'requirements' && basename(path) !== '.python-version'
      ? []
      : targetsInFile(path, source);
  if (targets.length === 0) return [];
  const latestVersion = await runtimeFeeds.python();
  return targets.map((target) =>
    runtimeCandidate({
      ...target,
      kind: 'python',
      latestVersion,
      requires: null,
      manifestPath: path,
      projectLabel: label,
    }),
  );
}

/** What the manifest itself names, then the `.python-version` beside it. */
async function manifestRuntimes(
  root: string,
  manifestPath: string,
  source: string,
  label: string,
): Promise<RuntimeCandidate[]> {
  const dir = dirname(manifestPath);
  const versionFile = join(dir, '.python-version');
  const versionSource = await readFileSafe(versionFile);
  return [
    ...(await candidatesInFile(manifestPath, source, label)),
    ...(versionSource === null
      ? []
      : await candidatesInFile(versionFile, versionSource, projectLabel(root, dir))),
  ];
}

async function scanManifest(
  root: string,
  manifestPath: string,
  health: HostHealth,
): Promise<ScannedManifest | null> {
  const source = await readFileSafe(manifestPath);
  if (source === null) return null;
  const dir = dirname(manifestPath);
  const kind = fileKind(manifestPath);
  if (kind === 'requirements') {
    const label = relative(root, manifestPath);
    return {
      manager: 'pip',
      rows: readRequirementsFile(source, manifestPath).map((dep) =>
        toRow(dep, null, manifestPath, label, health),
      ),
      runtimes: () => manifestRuntimes(root, manifestPath, source, label),
    };
  }
  if (kind === 'pipfile') {
    const lockSource = await readFileSafe(`${manifestPath}.lock`);
    const locked = lockSource ? readPipfileLock(lockSource) : new Map<string, string[]>();
    const label = projectLabel(root, dir);
    return {
      manager: 'pipenv',
      rows: readPipfile(source).map((dep) =>
        toRow(dep, locked.get(normalize(dep.name))?.[0] ?? null, manifestPath, label, health),
      ),
      runtimes: () => manifestRuntimes(root, manifestPath, source, label),
    };
  }

  const pyproject = readPyproject(source);
  const manager = await managerOf(pyproject, dir, root);
  const lockFile = manager === 'pip' ? null : await findUpward(dir, root, `${manager}.lock`);
  const locked = lockFile ? lockedVersions(lockFile.source, normalize) : new Map();
  const label = projectLabel(root, dir, pyproject.name);
  return {
    manager,
    rows: pyproject.declared.map((dep) =>
      toRow(dep, locked.get(normalize(dep.name))?.[0] ?? null, manifestPath, label, health),
    ),
    runtimes: () => manifestRuntimes(root, manifestPath, source, label),
  };
}

async function listPackages(folderPath: string): Promise<PackageManagerSection[]> {
  const manifests = await findManifests(folderPath, isManifest);
  const health = new HostHealth();
  const scanned = (
    await Promise.all(manifests.map((path) => scanManifest(folderPath, path, health)))
  ).filter((one): one is ScannedManifest => one !== null);

  const sections: PackageManagerSection[] = [];
  for (const manager of ['pip', 'uv', 'poetry', 'pipenv'] as const) {
    const ofManager = scanned.filter((one) => one.manager === manager);
    const rows = ofManager.flatMap((one) => one.rows);
    const candidates = (await Promise.all(ofManager.map((one) => one.runtimes()))).flat();
    // Several requirements files in one folder share its .python-version.
    const runtimes = [
      ...new Map<string, RuntimeTarget>(
        candidates.map(({ target }) => [`${target.source}:${target.manifestPath}`, target]),
      ).values(),
    ];
    if (rows.length === 0 && runtimes.length === 0) continue;
    const { packages, unresolved } = await checkPackages(rows);
    const notes = [
      unresolvedNote(unresolved, health),
      manager === 'pip' && rows.length > 0
        ? 'An update changes the requirement in the file. Run pip install in your environment afterwards.'
        : null,
    ].filter((note): note is string => note !== null);
    sections.push({
      ecosystem: 'python',
      manager,
      status: 'ok',
      message: notes.length > 0 ? notes.join(' ') : null,
      packages,
      runtimes,
      toolchain: null,
    });
  }
  return sections;
}

// --- Updating ----------------------------------------------------------------

const CLAUSE = /^(\s*)(===|==|~=|>=|<=|!=|\^|~|>|<)?(\s*)(\d[^\s,]*)(\s*)$/;

/** The specifier with `target` written in, in the same operators and precision as before. */
export function nextSpecifier(specifier: string, target: string): string {
  const separator = specifier.includes(', ') ? ', ' : ',';
  const clauses: string[] = [];
  for (const clause of specifier.split(',')) {
    const match = CLAUSE.exec(clause);
    if (!match) {
      clauses.push(clause.trim());
      continue;
    }
    const [, , operator = '', gap, version] = match;
    const written = (value: string) => `${operator}${gap}${value}`;
    const major = Number(target.split('.')[0]);
    switch (operator) {
      case '<': {
        if (compareLoose(target, version) < 0) clauses.push(written(version));
        else {
          const zeros = version.split('.').slice(1).fill('0');
          clauses.push(written([major + 1, ...zeros].join('.')));
        }
        break;
      }
      case '<=':
        clauses.push(written(compareLoose(target, version) > 0 ? target : version));
        break;
      case '>':
        clauses.push(written(version));
        break;
      case '!=':
        if (compareLoose(target, version) !== 0) clauses.push(written(version));
        break;
      case '':
      case '==':
      case '===':
        clauses.push(
          written(
            version.endsWith('.*') ? `${withPrecisionOf(target, version.slice(0, -2))}.*` : target,
          ),
        );
        break;
      default:
        clauses.push(written(withPrecisionOf(target, version)));
    }
  }
  return clauses.join(separator);
}

function readDeclared(source: string, manifestPath: string): Declared[] {
  const kind = fileKind(manifestPath);
  if (kind === 'requirements') return readRequirementsFile(source, manifestPath);
  return kind === 'pipfile' ? readPipfile(source) : readPyproject(source).declared;
}

async function rewriteManifest(
  manifestPath: string,
  group: PackageUpdateRequest[],
  source: string,
): Promise<PackageUpdateItemResult[]> {
  const declared = readDeclared(source, manifestPath);
  const edits: TextEdit[] = [];
  const results = group.map((update) => {
    const matching = declared.filter((dep) => normalize(dep.name) === normalize(update.name));
    if (matching.length === 0) return missingFromManifest(update.name, manifestPath);
    for (const dep of matching) {
      if (dep.specifier) {
        edits.push({
          start: dep.start,
          end: dep.end,
          text: nextSpecifier(dep.specifier, update.targetVersion),
        });
      }
    }
    return { name: update.name, ok: true, message: 'Updated' };
  });
  if (edits.length > 0) await writeManifest(manifestPath, applyEdits(source, edits), 'utf-8');
  return results;
}

function groupFlags(group: DependencyGroup, tool: PythonTool): string[] {
  if (group.kind === 'optional') return ['--optional', group.name];
  if (group.kind === 'group') return ['--group', group.name];
  if (group.kind === 'dev') return tool === 'poetry' ? ['--group', 'dev'] : ['--dev'];
  return [];
}

function requirementArgument(dep: Declared, target: string, tool: PythonTool): string {
  const specifier = dep.specifier ? nextSpecifier(dep.specifier, target) : '';
  if (tool === 'pipenv' && !specifier) return dep.name;
  const name = `${dep.name}${dep.extras}`;
  if (tool === 'poetry') return `${name}@${specifier || '*'}`;
  return `${name}${specifier}`;
}

const TOOL_NAMES = { uv: 'uv', poetry: 'Poetry', pipenv: 'Pipenv' } as const;

/** Pipenv has no `add`, and `install` of a bare name would not move a package declared as any. */
function toolVerb(tool: PythonTool, dep: Declared): string {
  if (tool !== 'pipenv') return 'add';
  return dep.specifier ? 'install' : 'update';
}

/** One `add` per dependency group, since the group is a flag on the whole command. */
async function updateWithTool(
  tool: PythonTool,
  manifestPath: string,
  group: PackageUpdateRequest[],
  source: string,
): Promise<PackageUpdateItemResult[]> {
  const declared = readDeclared(source, manifestPath);
  const results: PackageUpdateItemResult[] = [];
  const commands = new Map<
    string,
    { verb: string; flags: string[]; updates: [PackageUpdateRequest, Declared][] }
  >();
  for (const update of group) {
    const dep = declared.find((one) => normalize(one.name) === normalize(update.name));
    if (!dep) {
      results.push(missingFromManifest(update.name, manifestPath));
      continue;
    }
    const flags = groupFlags(dep.group, tool);
    const verb = toolVerb(tool, dep);
    const key = `${verb} ${flags.join(' ')}`;
    const command = commands.get(key) ?? { verb, flags, updates: [] };
    command.updates.push([update, dep]);
    commands.set(key, command);
  }

  for (const { verb, flags, updates } of commands.values()) {
    const upgrades =
      tool === 'uv' ? updates.flatMap(([, dep]) => ['--upgrade-package', dep.name]) : [];
    const args = [
      verb,
      ...flags,
      ...upgrades,
      ...updates.map(([update, dep]) => requirementArgument(dep, update.targetVersion, tool)),
    ];
    let ok = false;
    let message: string;
    try {
      const { code, stdout, stderr } = await runCli(
        tool,
        args,
        dirname(manifestPath),
        UPDATE_TIMEOUT_MS,
      );
      ok = code === 0;
      message = ok
        ? 'Updated'
        : (stderr || stdout).slice(-500) || `${tool} exited with code ${code}`;
    } catch (err) {
      message =
        err instanceof CliNotFoundError
          ? `Install ${TOOL_NAMES[tool]} and add it to PATH to update these packages.`
          : err instanceof Error
            ? err.message
            : `${tool} add failed.`;
    }
    results.push(...updates.map(([update]) => ({ name: update.name, ok, message })));
  }
  return results;
}

/** Brings the lock in line after the Python version moved, where that is safe to do here. */
async function afterRuntimeUpdate(
  folderPath: string,
  request: RuntimeUpdateRequest,
  source: string,
  result: RuntimeUpdateResult,
): Promise<RuntimeUpdateResult> {
  const dir = dirname(request.manifestPath);
  if (request.source === 'pipfile-python') {
    return (await readFileSafe(`${request.manifestPath}.lock`)) === null
      ? result
      : { ...result, message: `${result.message} Run pipenv lock to bring the lock file in line.` };
  }
  if (request.source === 'python-version-file') return result;
  const manager = await managerOf(readPyproject(source), dir, folderPath);
  if (manager === 'poetry' && (await findUpward(dir, folderPath, 'poetry.lock'))) {
    // Before Poetry 2 a plain `poetry lock` also moves every other package.
    return {
      ...result,
      message: `${result.message} Run poetry lock to bring the lock file in line.`,
    };
  }
  if (manager !== 'uv' || !(await findUpward(dir, folderPath, 'uv.lock'))) return result;
  try {
    const { code, stdout, stderr } = await runCli('uv', ['lock'], dir, UPDATE_TIMEOUT_MS);
    if (code === 0) return result;
    const tail = (stderr || stdout).slice(-500) || `uv exited with code ${code}`;
    return { ok: false, message: `${result.message} Then uv lock failed: ${tail}` };
  } catch (err) {
    const why = err instanceof Error ? err.message : 'uv lock failed.';
    return { ok: false, message: `${result.message} Then uv lock could not run: ${why}` };
  }
}

async function updateRuntime(
  folderPath: string,
  request: RuntimeUpdateRequest,
  deps: RuntimeUpdateDeps,
): Promise<RuntimeUpdateResult> {
  const source = await readFileSafe(request.manifestPath);
  if (source === null) return { ok: false, message: `Failed to read ${request.manifestPath}.` };
  const result = await applyRuntimeUpdate(
    request,
    await candidatesInFile(request.manifestPath, source, ''),
    deps,
  );
  return result.ok ? afterRuntimeUpdate(folderPath, request, source, result) : result;
}

export const pythonAdapter: PackageManagerAdapter = {
  ecosystem: 'python',
  async detect(folderPath) {
    return (await findManifests(folderPath, isManifest)).length > 0;
  },
  async readInventory(folderPath) {
    const manifests = await findManifests(folderPath, isManifest);
    const health = new HostHealth();
    const scanned = await Promise.all(
      manifests.map((path) => scanManifest(folderPath, path, health)),
    );
    return inventoryOf(scanned.flatMap((one) => one?.rows ?? []));
  },
  listPackages,
  updatePackages(folderPath, updates, onProgress) {
    return updateByManifest(updates, onProgress, async (manifestPath, group) => {
      const source = await readFileSafe(manifestPath);
      if (source === null) throw new Error(`Failed to read ${manifestPath}.`);
      const kind = fileKind(manifestPath);
      if (kind === 'requirements') return rewriteManifest(manifestPath, group, source);
      if (kind === 'pipfile') return updateWithTool('pipenv', manifestPath, group, source);
      const manager = await managerOf(readPyproject(source), dirname(manifestPath), folderPath);
      return manager === 'pip'
        ? rewriteManifest(manifestPath, group, source)
        : updateWithTool(manager, manifestPath, group, source);
    });
  },
  updateRuntime,
};
