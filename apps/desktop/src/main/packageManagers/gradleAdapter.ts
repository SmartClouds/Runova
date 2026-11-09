import { basename, dirname } from 'node:path';
import type { PackageManagerSection, PackageUpdateItemResult } from '../../shared/apiTypes';
import {
  applyEdits,
  checkPackages,
  fetchText,
  findManifests,
  HostHealth,
  missingFromManifest,
  noRuntimeUpdates,
  type PackageRow,
  projectLabel,
  readFileSafe,
  unresolvedNote,
  updateByManifest,
  writeManifest,
} from './adapterKit';
import { inlineString, scanToml, stringValue, type TomlEntry, type TomlString } from './tomlScan';
import type { PackageManagerAdapter } from './types';
import { compareLoose, isBehind, pickLatest } from './versionText';

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

function isManifest(fileName: string, folder: string): boolean {
  return BUILD_SCRIPT.test(fileName) || (CATALOG.test(fileName) && basename(folder) === 'gradle');
}

interface Declaration {
  /** `group:artifact`, or a plugin id. */
  name: string;
  version: string;
  isPlugin: boolean;
  isDev: boolean;
  /** Where the version is in the file. */
  start: number;
  end: number;
}

function isTestScope(configuration: string): boolean {
  return /test|debug/i.test(configuration);
}

function readBuildScript(source: string): Declaration[] {
  const found: Declaration[] = [];
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
  }
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

function readDeclarations(source: string, manifestPath: string): Declaration[] {
  return CATALOG.test(manifestPath) ? readCatalog(source) : readBuildScript(source);
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
  health: HostHealth,
): Promise<PackageRow[]> {
  const source = await readFileSafe(manifestPath);
  if (source === null) return [];
  const folder = dirname(manifestPath);
  const owner = CATALOG.test(manifestPath) ? dirname(folder) : folder;
  const label = projectLabel(root, owner);

  const rows = new Map<string, PackageRow>();
  for (const item of readDeclarations(source, manifestPath)) {
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
    });
  }
  return [...rows.values()];
}

async function listPackages(folderPath: string): Promise<PackageManagerSection[]> {
  const manifests = await findManifests(folderPath, isManifest);
  const health = new HostHealth();
  const rows = (
    await Promise.all(manifests.map((path) => scanManifest(folderPath, path, health)))
  ).flat();
  if (rows.length === 0) return [];
  const { packages, unresolved } = await checkPackages(rows);
  return [
    {
      ecosystem: 'kotlin',
      manager: 'gradle',
      status: 'ok',
      message: unresolvedNote(unresolved, health),
      packages,
      runtimes: [],
      toolchain: null,
    },
  ];
}

export const gradleAdapter: PackageManagerAdapter = {
  ecosystem: 'kotlin',
  async detect(folderPath) {
    return (await findManifests(folderPath, isManifest)).length > 0;
  },
  // Dependency alerts are checked on the server, which does not know Maven yet.
  readInventory: async () => [],
  listPackages,
  updatePackages(_folderPath, updates, onProgress) {
    return updateByManifest(updates, onProgress, async (manifestPath, group) => {
      const source = await readFileSafe(manifestPath);
      if (source === null) throw new Error(`Failed to read ${manifestPath}.`);
      const declarations = readDeclarations(source, manifestPath);
      // Libraries can share one catalog version, so edits are by place, and the newest one wins.
      const edits = new Map<number, { start: number; end: number; text: string }>();
      const results: PackageUpdateItemResult[] = group.map((update) => {
        const matching = declarations.filter((item) => item.name === update.name);
        if (matching.length === 0) return missingFromManifest(update.name, manifestPath);
        for (const { start, end } of matching) {
          const existing = edits.get(start);
          if (!existing || compareLoose(update.targetVersion, existing.text) > 0) {
            edits.set(start, { start, end, text: update.targetVersion });
          }
        }
        return { name: update.name, ok: true, message: 'Updated' };
      });
      if (edits.size > 0) {
        await writeManifest(manifestPath, applyEdits(source, [...edits.values()]), 'utf-8');
      }
      return results;
    });
  },
  updateRuntime: noRuntimeUpdates,
};
