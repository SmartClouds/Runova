/**
 * Reading the names caches give their folders. Each tool has its own shape, and each parser here
 * is deliberately strict: a name it does not recognise is left alone by version pruning, which is
 * the safe way for this to fail.
 *
 * The examples in the tests are real names from a developer machine.
 */

export interface NameVersion {
  name: string;
  version: string;
}

/**
 * `name-1.2.3`, as pub and Cargo write it. The name may hold dashes and digits (`bevy-2d-0.1.0`),
 * so the split is at the first dash that leaves three dotted numbers behind it.
 */
export function splitDashVersion(entry: string): NameVersion | null {
  const match = /^(.+?)-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(entry);
  if (!match?.[1] || !match[2]) return null;
  return { name: match[1], version: match[2] };
}

/** The entries Bun keeps for git and tarball dependencies, which have no version to compare. */
export function isBunSpecialEntry(entry: string): boolean {
  return /^@(?:GH|T|G)@/.test(entry);
}

/** An `@scope` folder, which holds the packages of that scope. */
export function isBunScopeDir(entry: string): boolean {
  return /^@[^@/]+$/.test(entry);
}

/** `react@19.2.8@@@1`, a package version in Bun's cache. */
export function splitBunEntry(entry: string): NameVersion | null {
  if (isBunSpecialEntry(entry)) return null;
  const match = /^(.+)@([^@]+)@@@\d+$/.exec(entry);
  if (!match?.[1] || !match[2]) return null;
  return { name: match[1], version: match[2] };
}

export interface GradleDist {
  flavour: 'bin' | 'all';
  version: string;
}

/** `gradle-9.4.1-bin`, a Gradle distribution the wrapper downloaded. */
export function splitGradleDist(entry: string): GradleDist | null {
  const match = /^gradle-(.+)-(bin|all)$/.exec(entry);
  if (!match?.[1] || !match[2]) return null;
  return { flavour: match[2] as 'bin' | 'all', version: match[1] };
}

/** A folder under Gradle's `caches` that belongs to one Gradle version (`9.4.1`). */
export function isGradleVersionDir(entry: string): boolean {
  return /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.test(entry);
}

export interface RevisionEntry {
  family: string;
  revision: string;
}

/** `chromium-1234`, a browser build Playwright downloaded: the family and its revision number. */
export function splitRevisionEntry(entry: string): RevisionEntry | null {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)-(\d+)$/.exec(entry);
  if (!match?.[1] || !match[2]) return null;
  return { family: match[1], revision: match[2] };
}

export interface ElectronArtifact {
  /** The artifact and the platform it is for, which is what versions of it compete within. */
  group: string;
  version: string;
}

/** `electron-v43.1.1-win32-x64.zip`, a download in Electron's cache. */
export function splitElectronArtifact(fileName: string): ElectronArtifact | null {
  const match =
    /^([a-z][a-z0-9_]*?)-v(\d+\.\d+\.\d+(?:-(?:alpha|beta|nightly|rc)(?:\.[0-9A-Za-z]+)*)?)-(.+)\.zip$/.exec(
      fileName,
    );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { group: `${match[1]}-${match[3]}`, version: match[2] };
}

/** Go writes a capital as `!` and the lower-case letter, so the cache works on any filesystem. */
export function decodeGoPath(path: string): string {
  return path.replace(/!([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** `net@v0.20.0`, a folder holding one version of a module. */
export function splitGoVersionDir(entry: string): NameVersion | null {
  const match = /^(.+)@(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(entry);
  if (!match?.[1] || !match[2]) return null;
  return { name: match[1], version: match[2] };
}
