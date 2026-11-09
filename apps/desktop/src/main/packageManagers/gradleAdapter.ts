import { basename, dirname } from 'node:path';
import type {
  PackageManagerSection,
  PackageUpdateItemResult,
  RuntimeSource,
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
import { runtimeFeeds } from './runtimeFeeds';
import {
  applyRuntimeUpdate,
  type RuntimeCandidate,
  type RuntimeUpdateDeps,
  runtimeCandidate,
} from './runtimeUpdate';
import { inlineString, scanToml, stringValue, type TomlEntry, type TomlString } from './tomlScan';
import type { PackageManagerAdapter } from './types';
import { compareLoose, isBehind, pickLatest, withoutFlavor } from './versionText';

/**
 * Gradle reads its versions from the build files on every build, so updating is only ever a matter
 * of changing the text. No CLI is involved at any point.
 */

const BUILD_SCRIPT = /^(?:build|settings)\.gradle(?:\.kts)?$/;
const CATALOG = /\.versions\.toml$/;

const GOOGLE_MAVEN = 'https://dl.google.com/dl/android/maven2';
const MAVEN_CENTRAL = 'https://repo1.maven.org/maven2';
const GRADLE_PLUGIN_PORTAL = 'https://plugins.gradle.org/m2';
/** Groups Google publishes on its own repository rather than on Maven Central. */
const GOOGLE_GROUP =
  /^(?:androidx|android\.arch|com\.android|com\.google\.android|com\.google\.firebase|com\.google\.gms|com\.google\.testing\.platform)(?:\.|$)/;
/** Comes out of the Flutter SDK on the machine, not out of any repository. */
const LOCAL_PLUGIN = /^dev\.flutter\./;

const VERSION = String.raw`\d[A-Za-z0-9_.-]*`;
const COORDINATE = new RegExp(
  String.raw`\b([A-Za-z]\w*)\s*(?:\(\s*)?(?:(?:platform|enforcedPlatform)\s*\(\s*)?(["'])([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):(${VERSION})(@[A-Za-z]+)?\2`,
  'g',
);
const PLUGIN_ID = new RegExp(
  String.raw`\bid\s*\(?\s*(["'])([A-Za-z0-9_.-]+)\1\s*\)?\s+version\s*\(?\s*(["'])(${VERSION})\3`,
  'g',
);
const KOTLIN_PLUGIN = new RegExp(
  String.raw`\bkotlin\s*\(\s*"([a-z0-9.-]+)"\s*\)\s+version\s+"(${VERSION})"`,
  'g',
);

/** `$name`, `${name}`, `${project.ext.name}`, `${extra["name"]}` or `${property("name")}`. */
const REFERENCE = String.raw`\$\{?\s*(?:rootProject\.|project\.)?(?:ext\.|extra\[["']|property\(["']|properties\[["'])?([A-Za-z_]\w*)(?:["']\]|["']\))?\s*\}?`;
const COORDINATE_REFERENCE = new RegExp(
  String.raw`\b([A-Za-z]\w*)\s*(?:\(\s*)?(?:(?:platform|enforcedPlatform)\s*\(\s*)?(["'])([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):${REFERENCE}(?:@[A-Za-z]+)?\2`,
  'g',
);
const PLUGIN_VERSION_REFERENCE = String.raw`version\s*\(?\s*(?:"${REFERENCE}"|([A-Za-z_]\w*)\b(?!\s*[.(]))`;
const PLUGIN_ID_REFERENCE = new RegExp(
  String.raw`\bid\s*\(?\s*["']([A-Za-z0-9_.-]+)["']\s*\)?\s+${PLUGIN_VERSION_REFERENCE}`,
  'g',
);
const KOTLIN_PLUGIN_REFERENCE = new RegExp(
  String.raw`\bkotlin\s*\(\s*"([a-z0-9.-]+)"\s*\)\s+${PLUGIN_VERSION_REFERENCE}`,
  'g',
);

const VARIABLE_FORMS = [
  new RegExp(
    String.raw`\b(?:val|var|def|String)\s+(\w+)(?:\s*:\s*String)?\s*=\s*["'](${VERSION})["']`,
    'g',
  ),
  new RegExp(String.raw`\bext\.(\w+)\s*=\s*["'](${VERSION})["']`, 'g'),
  new RegExp(String.raw`\b(?:extra|ext)\[["'](\w+)["']\]\s*=\s*["'](${VERSION})["']`, 'g'),
  new RegExp(String.raw`\bval\s+(\w+)\s+by\s+extra\(\s*["'](${VERSION})["']\s*\)`, 'g'),
];
const EXT_BLOCK_ENTRY = new RegExp(String.raw`^\s*(\w+)\s*=\s*["'](${VERSION})["']`);
const PROPERTY_LINE = new RegExp(String.raw`^\s*([\w.-]+)\s*[=:]\s*(${VERSION})\s*$`);

function isManifest(fileName: string, folder: string): boolean {
  return BUILD_SCRIPT.test(fileName) || (CATALOG.test(fileName) && basename(folder) === 'gradle');
}

interface Declaration {
  /** `group:artifact`, or a plugin id. */
  name: string;
  version: string;
  isPlugin: boolean;
  isDev: boolean;
  /** Where the version is written. */
  start: number;
  end: number;
  /** Set when a variable in another file holds the version. */
  file?: string;
}

/** A version written once under a name, for build scripts to use. */
interface Variable {
  value: string;
  file: string;
  start: number;
  end: number;
}

type Resolve = (name: string) => Variable | null;

function isTestScope(configuration: string): boolean {
  return /test|debug/i.test(configuration);
}

/** Calls `visit` for each line that is not a comment. */
function forEachCodeLine(source: string, visit: (line: string, lineStart: number) => void): void {
  let offset = 0;
  let inBlockComment = false;
  for (const line of source.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trimStart();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      inBlockComment = !line.includes('*/');
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    visit(line, lineStart);
  }
}

function readVariables(source: string, file: string): Map<string, Variable> {
  const variables = new Map<string, Variable>();
  const add = (name: string, value: string, start: number) =>
    variables.set(name, { value, file, start, end: start + value.length });
  let extDepth = 0;
  forEachCodeLine(source, (line, lineStart) => {
    for (const form of VARIABLE_FORMS) {
      for (const match of line.matchAll(form)) {
        add(match[1], match[2], lineStart + match.index + match[0].lastIndexOf(match[2]));
      }
    }
    if (extDepth > 0) {
      const entry = EXT_BLOCK_ENTRY.exec(line);
      if (entry) add(entry[1], entry[2], lineStart + entry[0].lastIndexOf(entry[2]));
    }
    if (extDepth > 0 || /\bext\s*\{/.test(line)) {
      extDepth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    }
  });
  return variables;
}

function readProperties(source: string, file: string): Map<string, Variable> {
  const variables = new Map<string, Variable>();
  let offset = 0;
  for (const raw of source.split('\n')) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    const match = line.trimStart().startsWith('#') ? null : PROPERTY_LINE.exec(line);
    if (match) {
      const start = lineStart + line.lastIndexOf(match[2]);
      variables.set(match[1], { value: match[2], file, start, end: start + match[2].length });
    }
  }
  return variables;
}

/** Every folder's variables, read once per scan: `gradle.properties` and the build scripts. */
async function loadVariables(root: string): Promise<Map<string, Map<string, Variable>>> {
  const files = await findManifests(
    root,
    (fileName) => BUILD_SCRIPT.test(fileName) || fileName === 'gradle.properties',
  );
  const byFolder = new Map<string, Map<string, Variable>>();
  // Properties go in first so that a script's own value wins over one of the same name.
  files.sort(
    (a, b) => Number(BUILD_SCRIPT.test(basename(a))) - Number(BUILD_SCRIPT.test(basename(b))),
  );
  for (const file of files) {
    const source = await readFileSafe(file);
    if (source === null) continue;
    const found = BUILD_SCRIPT.test(basename(file))
      ? readVariables(source, file)
      : readProperties(source, file);
    const folder = dirname(file);
    byFolder.set(folder, new Map([...(byFolder.get(folder) ?? []), ...found]));
  }
  return byFolder;
}

/** A module sees its own values and those of the folders above it, never a sibling's. */
function resolverFor(
  variables: Map<string, Map<string, Variable>>,
  root: string,
  from: string,
): Resolve {
  return (name) => {
    let folder = from;
    for (;;) {
      const found = variables.get(folder)?.get(name);
      if (found) return found;
      const parent = dirname(folder);
      if (folder === root || parent === folder) return null;
      folder = parent;
    }
  };
}

function fromVariable(
  name: string,
  variable: Variable,
  isPlugin: boolean,
  isDev: boolean,
): Declaration {
  return {
    name,
    version: variable.value,
    isPlugin,
    isDev,
    start: variable.start,
    end: variable.end,
    file: variable.file,
  };
}

function readBuildScript(source: string, resolve: Resolve): Declaration[] {
  const found: Declaration[] = [];
  forEachCodeLine(source, (line, lineStart) => {
    for (const match of line.matchAll(COORDINATE_REFERENCE)) {
      const [, configuration, , group, artifact, reference] = match;
      const variable = resolve(reference);
      if (variable) {
        found.push(
          fromVariable(`${group}:${artifact}`, variable, false, isTestScope(configuration)),
        );
      }
    }
    for (const [pattern, prefix] of [
      [PLUGIN_ID_REFERENCE, ''],
      [KOTLIN_PLUGIN_REFERENCE, 'org.jetbrains.kotlin.'],
    ] as const) {
      for (const match of line.matchAll(pattern)) {
        const variable = resolve(match[2] ?? match[3]);
        if (variable) found.push(fromVariable(`${prefix}${match[1]}`, variable, true, false));
      }
    }
    for (const match of line.matchAll(COORDINATE)) {
      const [whole, configuration, , group, artifact, version] = match;
      const start =
        lineStart +
        match.index +
        whole.indexOf(`${group}:${artifact}:`) +
        group.length +
        artifact.length +
        2;
      found.push({
        name: `${group}:${artifact}`,
        version,
        isPlugin: false,
        isDev: isTestScope(configuration),
        start,
        end: start + version.length,
      });
    }
    for (const match of line.matchAll(PLUGIN_ID)) {
      const [whole, , id, , version] = match;
      const start = lineStart + match.index + whole.lastIndexOf(version);
      found.push({
        name: id,
        version,
        isPlugin: true,
        isDev: false,
        start,
        end: start + version.length,
      });
    }
    for (const match of line.matchAll(KOTLIN_PLUGIN)) {
      const [whole, id, version] = match;
      const start = lineStart + match.index + whole.lastIndexOf(version);
      found.push({
        name: `org.jetbrains.kotlin.${id}`,
        version,
        isPlugin: true,
        isDev: false,
        start,
        end: start + version.length,
      });
    }
  });
  return found;
}

function declaration(name: string, version: TomlString, isPlugin: boolean): Declaration {
  return {
    name,
    version: version.value,
    isPlugin,
    isDev: false,
    start: version.start,
    end: version.end,
  };
}

/** The version part of a `"group:artifact:1.0"` or `"plugin.id:1.0"` shorthand. */
function shorthand(value: TomlString, isPlugin: boolean): Declaration | null {
  const at = value.value.lastIndexOf(':');
  const name = value.value.slice(0, at);
  if (at === -1 || (!isPlugin && !name.includes(':'))) return null;
  const version = value.value.slice(at + 1);
  return declaration(
    name,
    { value: version, start: value.start + at + 1, end: value.end },
    isPlugin,
  );
}

function readCatalog(source: string): Declaration[] {
  const entries = scanToml(source);
  const versions = new Map<string, TomlString>();
  for (const entry of entries) {
    if (entry.table !== 'versions') continue;
    const value = stringValue(entry);
    if (value) versions.set(entry.key, value);
  }

  function versionOf(entry: TomlEntry): TomlString | null {
    const reference = inlineString(entry, 'version.ref');
    if (reference) return versions.get(reference.value) ?? null;
    return inlineString(entry, 'version');
  }

  const found: Declaration[] = [];
  for (const entry of entries) {
    if (entry.table !== 'libraries' && entry.table !== 'plugins') continue;
    const isPlugin = entry.table === 'plugins';
    const written = stringValue(entry);
    if (written) {
      const short = shorthand(written, isPlugin);
      if (short) found.push(short);
      continue;
    }
    const version = versionOf(entry);
    if (!version) continue;
    const module = inlineString(entry, 'module')?.value;
    const group = inlineString(entry, 'group')?.value;
    const artifact = inlineString(entry, 'name')?.value;
    const name = isPlugin
      ? inlineString(entry, 'id')?.value
      : (module ?? (group && artifact ? `${group}:${artifact}` : undefined));
    if (name) found.push(declaration(name, version, isPlugin));
  }
  return found;
}

function readDeclarations(source: string, manifestPath: string, resolve: Resolve): Declaration[] {
  return CATALOG.test(manifestPath) ? readCatalog(source) : readBuildScript(source, resolve);
}

/** Maven metadata is plain enough that the version tags are all that needs reading. */
function versionsIn(metadata: string): string[] {
  return [...metadata.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1].trim());
}

function repositoriesFor(item: Declaration): { base: string; group: string; artifact: string }[] {
  const [group, artifact] = item.isPlugin
    ? [item.name, `${item.name}.gradle.plugin`]
    : item.name.split(':');
  const google = { base: GOOGLE_MAVEN, group, artifact };
  const central = { base: MAVEN_CENTRAL, group, artifact };
  if (item.isPlugin) {
    const portal = { base: GRADLE_PLUGIN_PORTAL, group, artifact };
    return GOOGLE_GROUP.test(group) ? [google, portal, central] : [portal, central];
  }
  return GOOGLE_GROUP.test(group) ? [google, central] : [central, google];
}

/** Repositories are tried in turn, since a build can name any of them and its own besides. */
async function lookup(item: Declaration, health: HostHealth): Promise<string | null> {
  for (const { base, group, artifact } of repositoriesFor(item)) {
    const url = `${base}/${group.replaceAll('.', '/')}/${artifact}/maven-metadata.xml`;
    const metadata = await fetchText(url, health);
    if (metadata) return pickLatest(versionsIn(metadata), item.version);
  }
  return null;
}

async function scanManifest(
  root: string,
  manifestPath: string,
  variables: Map<string, Map<string, Variable>>,
  health: HostHealth,
): Promise<PackageRow[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) return [];
  const folder = dirname(manifestPath);
  const owner = CATALOG.test(manifestPath) ? dirname(folder) : folder;
  const label = projectLabel(root, owner);

  const rows = new Map<string, PackageRow>();
  const resolve = resolverFor(variables, root, folder);
  for (const item of readDeclarations(source, manifestPath, resolve)) {
    const existing = rows.get(item.name);
    if (existing) {
      existing.isDev = existing.isDev && item.isDev;
      continue;
    }
    rows.set(item.name, {
      name: item.name,
      currentVersion: item.version,
      isDev: item.isDev,
      isInstalled: true,
      manifestPath,
      projectLabel: label,
      lookup: LOCAL_PLUGIN.test(item.name) ? null : () => lookup(item, health),
      behind: (latest) => isBehind(item.version, null, latest),
      // Facts are kept per package, so one flavor's number has to stand for all of them.
      inventory: item.isPlugin
        ? undefined
        : { ecosystem: 'maven', name: item.name, version: withoutFlavor(item.version) },
    });
  }
  return [...rows.values()];
}

// --- Runtime versions --------------------------------------------------------

const WRAPPER_FILE = /(?:^|[\\/])gradle-wrapper\.properties$/;
const WRAPPER_URL = /^(\s*distributionUrl\s*=.*?gradle-)(\d+(?:\.\d+){1,2})(-(?:bin|all)\.zip)/m;

function isWrapper(fileName: string, folder: string): boolean {
  return fileName === 'gradle-wrapper.properties' && basename(folder) === 'wrapper';
}

const SDK_LINE = {
  compile: /\bcompileSdk(?:Version)?\s*(?:=\s*|\(\s*|\s+)(\d+)\b/,
  target: /\btargetSdk(?:Version)?\s*(?:=\s*|\(\s*|\s+)(\d+)\b/,
} as const;

interface SdkLevel {
  value: string;
  start: number;
  end: number;
}

function findSdkLevel(source: string, which: keyof typeof SDK_LINE): SdkLevel | null {
  let found: SdkLevel | null = null;
  forEachCodeLine(source, (line, lineStart) => {
    const match = found ? null : SDK_LINE[which].exec(line);
    if (!match) return;
    const start = lineStart + match.index + match[0].lastIndexOf(match[1]);
    found = { value: match[1], start, end: start + match[1].length };
  });
  return found;
}

async function wrapperCandidate(
  path: string,
  source: string,
  label: string,
): Promise<RuntimeCandidate[]> {
  const version = WRAPPER_URL.exec(source)?.[2];
  if (!version) return [];
  // A checksum names one exact file, so it would have to change along with the version.
  const pinned = /^\s*distributionSha256Sum\s*=/m.test(source);
  return [
    runtimeCandidate({
      kind: 'gradle',
      source: 'gradle-wrapper',
      declared: version,
      currentVersion: version,
      latestVersion: await runtimeFeeds.gradle(),
      // Always the whole version: Gradle 9 only publishes gradle-9.9.0-bin.zip.
      next: pinned ? null : (latest) => latest,
      requires: null,
      manifestPath: path,
      projectLabel: label,
      rewrite: (text, value) =>
        WRAPPER_URL.test(text)
          ? text.replace(WRAPPER_URL, (_all, before, _old, after) => `${before}${value}${after}`)
          : null,
    }),
  ];
}

async function androidCandidates(
  path: string,
  source: string,
  label: string,
): Promise<RuntimeCandidate[]> {
  const candidates: RuntimeCandidate[] = [];
  for (const [which, runtimeSource] of [
    ['compile', 'android-compile-sdk'],
    ['target', 'android-target-sdk'],
  ] as [keyof typeof SDK_LINE, RuntimeSource][]) {
    const level = findSdkLevel(source, which);
    if (!level) continue;
    candidates.push(
      runtimeCandidate({
        kind: 'android',
        source: runtimeSource,
        declared: level.value,
        currentVersion: level.value,
        latestVersion: await runtimeFeeds.androidApi(),
        next: (latest) => latest,
        requires: null,
        manifestPath: path,
        projectLabel: label,
        rewrite: (text, value) => {
          const current = findSdkLevel(text, which);
          return current ? text.slice(0, current.start) + value + text.slice(current.end) : null;
        },
      }),
    );
  }
  return candidates;
}

function candidatesInFile(
  path: string,
  source: string,
  label: string,
): Promise<RuntimeCandidate[]> {
  if (WRAPPER_FILE.test(path)) return wrapperCandidate(path, source, label);
  return /^build\.gradle/.test(basename(path))
    ? androidCandidates(path, source, label)
    : Promise.resolve([]);
}

async function runtimesOf(root: string, manifests: string[]): Promise<RuntimeCandidate[]> {
  const wrappers = await findManifests(root, isWrapper);
  const found = await Promise.all(
    [...wrappers, ...manifests].map(async (path) => {
      const source = await readFileSafe(path);
      if (source === null) return [];
      const owner = WRAPPER_FILE.test(path) ? dirname(dirname(dirname(path))) : dirname(path);
      return candidatesInFile(path, source, projectLabel(root, owner));
    }),
  );
  return found.flat();
}

async function scanAll(
  folderPath: string,
  manifests: string[],
  health: HostHealth,
): Promise<PackageRow[]> {
  const variables = await loadVariables(folderPath);
  const rows = await Promise.all(
    manifests.map((path) => scanManifest(folderPath, path, variables, health)),
  );
  return rows.flat();
}

async function listPackages(folderPath: string): Promise<PackageManagerSection[]> {
  const manifests = await findManifests(folderPath, isManifest);
  const health = new HostHealth();
  const rows = await scanAll(folderPath, manifests, health);
  const runtimes = (await runtimesOf(folderPath, manifests)).map((one) => one.target);
  if (rows.length === 0 && runtimes.length === 0) return [];
  const { packages, unresolved } = await checkPackages(rows);
  return [
    {
      ecosystem: 'kotlin',
      manager: 'gradle',
      status: 'ok',
      message: unresolvedNote(unresolved, health),
      packages,
      runtimes,
      toolchain: null,
    },
  ];
}

export const gradleAdapter: PackageManagerAdapter = {
  ecosystem: 'kotlin',
  async detect(folderPath) {
    return (await findManifests(folderPath, isManifest)).length > 0;
  },
  async readInventory(folderPath) {
    const manifests = await findManifests(folderPath, isManifest);
    return inventoryOf(await scanAll(folderPath, manifests, new HostHealth()));
  },
  listPackages,
  updatePackages(folderPath, updates, onProgress) {
    return updateByManifest(updates, onProgress, async (manifestPath, group) => {
      const source = await readFileSafe(manifestPath);
      if (source === null) throw new Error(`Failed to read ${manifestPath}.`);
      const variables = await loadVariables(folderPath);
      const resolve = resolverFor(variables, folderPath, dirname(manifestPath));
      const declarations = readDeclarations(source, manifestPath, resolve);
      // Libraries can share one version, so edits are by place, and the newest one wins.
      const edits = new Map<string, TextEdit & { file: string }>();
      const results: PackageUpdateItemResult[] = group.map((update) => {
        const matching = declarations.filter((item) => item.name === update.name);
        if (matching.length === 0) return missingFromManifest(update.name, manifestPath);
        for (const { start, end, file = manifestPath, version } of matching) {
          // An earlier module in this batch may have moved a shared value further already.
          if (compareLoose(update.targetVersion, version) <= 0) continue;
          const place = `${file}#${start}`;
          const existing = edits.get(place);
          if (!existing || compareLoose(update.targetVersion, existing.text) > 0) {
            edits.set(place, { file, start, end, text: update.targetVersion });
          }
        }
        return { name: update.name, ok: true, message: 'Updated' };
      });
      for (const file of new Set([...edits.values()].map((edit) => edit.file))) {
        const text = file === manifestPath ? source : await readFileSafe(file);
        if (text === null) throw new Error(`Failed to read ${file}.`);
        const forFile = [...edits.values()].filter((edit) => edit.file === file);
        await writeManifest(file, applyEdits(text, forFile), 'utf-8');
      }
      return results;
    });
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
