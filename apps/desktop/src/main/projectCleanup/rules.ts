import type { CleanupCategory, RestoreHint } from '../../shared/projectCleanupTypes';

/**
 * Which folders a project can rebuild, and under what conditions one may be offered for deletion.
 *
 * This is an allowlist on purpose. Nothing is offered because it is big or because git ignores
 * it: only a folder with one of these exact names, standing next to the file that explains it.
 * Source, `.git`, `.env*`, `.runova` and `.claude` have no rule, so they can never be offered,
 * and the removal re-runs the same rules so a forged request cannot reach them either.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

type RestoreKind = 'node' | 'pods' | 'venv' | 'dart' | 'composer' | 'output' | 'cache';

export interface CleanupRule {
  /** The exact folder name. */
  name: string;
  category: CleanupCategory;
  /** File names that may stand beside the folder to explain it. Any one will do. */
  markers: readonly string[];
  /** File name endings that may stand beside the folder (`.csproj`). Any one will do. */
  markerSuffixes: readonly string[];
  /** Names that must be inside the folder itself (a virtual environment's `pyvenv.cfg`). */
  inside: readonly string[];
  /**
   * Whether the name is also something people use for their own folders. Such a folder is
   * offered in a repository only when it is ignored by git as well as untracked.
   */
  ambiguous: boolean;
  restore: RestoreKind;
}

const NODE_PROJECT = ['package.json'];
/** What can stand beside a generic `dist`, `build` or `out` and make it build output. */
const BUILD_OWNERS = [
  'package.json',
  'build.gradle',
  'build.gradle.kts',
  'pubspec.yaml',
  'pyproject.toml',
  'setup.py',
  'CMakeLists.txt',
  'Makefile',
];
const DOTNET_SUFFIXES = ['.csproj', '.fsproj', '.vbproj'];

function rule(
  name: string,
  category: CleanupCategory,
  restore: RestoreKind,
  extra: Partial<Pick<CleanupRule, 'markers' | 'markerSuffixes' | 'inside' | 'ambiguous'>> = {},
): CleanupRule {
  return {
    name,
    category,
    restore,
    markers: extra.markers ?? [],
    markerSuffixes: extra.markerSuffixes ?? [],
    inside: extra.inside ?? [],
    ambiguous: extra.ambiguous ?? false,
  };
}

const RULES: readonly CleanupRule[] = [
  // Dependencies: reinstalled by the package manager.
  rule('node_modules', 'dependencies', 'node', { markers: NODE_PROJECT }),
  rule('Pods', 'dependencies', 'pods', { markers: ['Podfile'] }),
  rule('.venv', 'dependencies', 'venv', { inside: ['pyvenv.cfg'] }),
  rule('venv', 'dependencies', 'venv', { inside: ['pyvenv.cfg'] }),
  rule('.dart_tool', 'dependencies', 'dart', { markers: ['pubspec.yaml'] }),
  rule('vendor', 'dependencies', 'composer', { markers: ['composer.json'], ambiguous: true }),

  // Build output: made again by the next build.
  rule('dist', 'build', 'output', { markers: BUILD_OWNERS, ambiguous: true }),
  rule('build', 'build', 'output', { markers: BUILD_OWNERS, ambiguous: true }),
  rule('out', 'build', 'output', { markers: BUILD_OWNERS, ambiguous: true }),
  rule('.next', 'build', 'output', { markers: NODE_PROJECT }),
  rule('.nuxt', 'build', 'output', { markers: NODE_PROJECT }),
  rule('.output', 'build', 'output', { markers: NODE_PROJECT }),
  rule('target', 'build', 'output', { markers: ['Cargo.toml', 'pom.xml'], ambiguous: true }),
  rule('bin', 'build', 'output', { markerSuffixes: DOTNET_SUFFIXES, ambiguous: true }),
  rule('obj', 'build', 'output', { markerSuffixes: DOTNET_SUFFIXES, ambiguous: true }),

  // Caches: tools fill them again when they need them.
  rule('.turbo', 'cache', 'cache'),
  rule('.cache', 'cache', 'cache', { markers: NODE_PROJECT, ambiguous: true }),
  rule('.vite', 'cache', 'cache'),
  rule('.parcel-cache', 'cache', 'cache'),
  rule('.gradle', 'cache', 'cache'),
  rule('.kotlin', 'cache', 'cache'),
  rule('.pytest_cache', 'cache', 'cache'),
  rule('__pycache__', 'cache', 'cache'),
  rule('.sass-cache', 'cache', 'cache'),
  rule('.phpunit.cache', 'cache', 'cache'),
  rule('coverage', 'cache', 'cache', { markers: NODE_PROJECT, ambiguous: true }),
  rule('test-results', 'cache', 'cache', { markers: NODE_PROJECT }),
  rule('playwright-report', 'cache', 'cache', { markers: NODE_PROJECT }),
];

const BY_NAME: ReadonlyMap<string, CleanupRule> = new Map(RULES.map((r) => [r.name, r]));

/** The rule for a folder name, or null when nothing about that name may ever be offered. */
export function ruleForName(name: string): CleanupRule | null {
  return BY_NAME.get(name) ?? null;
}

/**
 * Whether the files around a folder explain it. `siblings` are the entries in the folder's
 * parent, `children` the entries inside the folder (only read for the rules that need them).
 */
export function markersSatisfied(
  candidate: CleanupRule,
  siblings: ReadonlySet<string>,
  children?: ReadonlySet<string>,
): boolean {
  if (candidate.inside.length > 0) {
    return children !== undefined && candidate.inside.some((name) => children.has(name));
  }
  const needsMarker = candidate.markers.length > 0 || candidate.markerSuffixes.length > 0;
  if (!needsMarker) return true;
  if (candidate.markers.some((name) => siblings.has(name))) return true;
  for (const entry of siblings) {
    if (candidate.markerSuffixes.some((suffix) => entry.endsWith(suffix))) return true;
  }
  return false;
}

/** Whether the rule reads the folder's own entries, so the scan knows to list it. */
export function needsChildren(candidate: CleanupRule): boolean {
  return candidate.inside.length > 0;
}

/** How the folder comes back, for the sentence under its name and the confirm dialog. */
export function restoreHint(candidate: CleanupRule, manager: PackageManager | null): RestoreHint {
  switch (candidate.restore) {
    case 'node':
      return {
        label: 'Comes back when you reinstall the dependencies.',
        command: `${manager ?? 'npm'} install`,
      };
    case 'pods':
      return { label: 'Comes back when you install the pods again.', command: 'pod install' };
    case 'venv':
      return {
        label: 'Comes back when you create the virtual environment again.',
        command: `python -m venv ${candidate.name}`,
      };
    case 'dart':
      return { label: 'Comes back when you fetch the packages again.', command: 'dart pub get' };
    case 'composer':
      return {
        label: 'Comes back when you install the packages again.',
        command: 'composer install',
      };
    case 'output':
      return { label: 'Comes back the next time you build the project.', command: null };
    case 'cache':
      return { label: 'Tools fill it again the next time they need it.', command: null };
  }
}
