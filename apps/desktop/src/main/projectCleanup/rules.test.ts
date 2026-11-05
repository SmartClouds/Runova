import { describe, expect, it } from 'vitest';
import { markersSatisfied, restoreHint, ruleForName } from './rules';

/** Built from its code point, so this file has none of its own. */
const EM_DASH = String.fromCharCode(0x2014);

const names = (...entries: string[]): ReadonlySet<string> => new Set(entries);

/** The rule for a folder name, or a failing test when there is none. */
function rule(name: string) {
  const found = ruleForName(name);
  if (!found) throw new Error(`No rule for "${name}"`);
  return found;
}

describe('ruleForName', () => {
  it.each([
    ['node_modules', 'dependencies'],
    ['Pods', 'dependencies'],
    ['.venv', 'dependencies'],
    ['venv', 'dependencies'],
    ['.dart_tool', 'dependencies'],
    ['vendor', 'dependencies'],
    ['dist', 'build'],
    ['build', 'build'],
    ['out', 'build'],
    ['.next', 'build'],
    ['.nuxt', 'build'],
    ['.output', 'build'],
    ['target', 'build'],
    ['bin', 'build'],
    ['obj', 'build'],
    ['.turbo', 'cache'],
    ['.cache', 'cache'],
    ['.vite', 'cache'],
    ['.parcel-cache', 'cache'],
    ['.gradle', 'cache'],
    ['.kotlin', 'cache'],
    ['.pytest_cache', 'cache'],
    ['__pycache__', 'cache'],
    ['.sass-cache', 'cache'],
    ['.phpunit.cache', 'cache'],
    ['coverage', 'cache'],
    ['test-results', 'cache'],
    ['playwright-report', 'cache'],
  ] as const)('puts %s in %s', (name, category) => {
    expect(rule(name).category).toBe(category);
  });

  it.each([
    // The things a person made, and the places Runova and git keep their own state.
    'src',
    'app',
    'lib',
    'docs',
    'public',
    'assets',
    'packages',
    'apps',
    'scripts',
    'tests',
    '.git',
    '.env',
    '.env.local',
    '.runova',
    '.claude',
    '.vscode',
    '.idea',
    '.github',
    'package.json',
  ])('never offers %s', (name) => {
    expect(ruleForName(name)).toBeNull();
  });

  it('matches the exact name only', () => {
    expect(ruleForName('node_modules_backup')).toBeNull();
    expect(ruleForName('my-dist')).toBeNull();
    expect(ruleForName('Node_Modules')).toBeNull();
    expect(ruleForName('')).toBeNull();
  });

  it('marks the names that other things also use as ambiguous', () => {
    for (const name of ['dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', 'coverage']) {
      expect(rule(name).ambiguous, name).toBe(true);
    }
    for (const name of ['node_modules', 'Pods', '.next', '.turbo', '.gradle', '__pycache__']) {
      expect(rule(name).ambiguous, name).toBe(false);
    }
  });
});

describe('markersSatisfied', () => {
  it('needs a package.json beside node_modules', () => {
    expect(markersSatisfied(rule('node_modules'), names('package.json', 'src'))).toBe(true);
    expect(markersSatisfied(rule('node_modules'), names('src'))).toBe(false);
  });

  it('needs a Podfile beside Pods', () => {
    expect(markersSatisfied(rule('Pods'), names('Podfile'))).toBe(true);
    expect(markersSatisfied(rule('Pods'), names('package.json'))).toBe(false);
  });

  it('needs pyvenv.cfg inside a virtual environment, so a folder that merely has the name stays', () => {
    expect(markersSatisfied(rule('.venv'), names(), names('pyvenv.cfg', 'Scripts'))).toBe(true);
    expect(markersSatisfied(rule('.venv'), names(), names('notes.md'))).toBe(false);
    expect(markersSatisfied(rule('venv'), names())).toBe(false);
  });

  it('needs a pubspec.yaml beside .dart_tool', () => {
    expect(markersSatisfied(rule('.dart_tool'), names('pubspec.yaml'))).toBe(true);
    expect(markersSatisfied(rule('.dart_tool'), names())).toBe(false);
  });

  it('needs a composer.json beside vendor', () => {
    expect(markersSatisfied(rule('vendor'), names('composer.json'))).toBe(true);
    expect(markersSatisfied(rule('vendor'), names('go.mod'))).toBe(false);
  });

  it.each([
    ['dist', 'package.json'],
    ['build', 'package.json'],
    ['build', 'build.gradle'],
    ['build', 'build.gradle.kts'],
    ['build', 'pubspec.yaml'],
    ['out', 'package.json'],
    ['target', 'Cargo.toml'],
    ['target', 'pom.xml'],
  ])('lets %s stand beside %s', (name, marker) => {
    expect(markersSatisfied(rule(name), names(marker))).toBe(true);
  });

  it.each(['dist', 'build', 'out', 'target'])(
    'leaves %s alone when nothing explains it',
    (name) => {
      expect(markersSatisfied(rule(name), names('README.md', 'index.html'))).toBe(false);
    },
  );

  it('needs a project file beside bin and obj', () => {
    expect(markersSatisfied(rule('obj'), names('App.csproj'))).toBe(true);
    expect(markersSatisfied(rule('bin'), names('Lib.fsproj'))).toBe(true);
    expect(markersSatisfied(rule('bin'), names('Tool.vbproj'))).toBe(true);
    expect(markersSatisfied(rule('bin'), names('run.sh'))).toBe(false);
  });

  it('asks nothing of the folders whose names are plainly a tool cache', () => {
    for (const name of ['.turbo', '.gradle', '.kotlin', '__pycache__', '.pytest_cache']) {
      expect(markersSatisfied(rule(name), names()), name).toBe(true);
    }
  });

  it('wants a package.json for the framework folders', () => {
    expect(markersSatisfied(rule('.next'), names('package.json'))).toBe(true);
    expect(markersSatisfied(rule('.next'), names())).toBe(false);
  });
});

describe('restoreHint', () => {
  it.each([
    ['pnpm', 'pnpm install'],
    ['npm', 'npm install'],
    ['yarn', 'yarn install'],
    ['bun', 'bun install'],
  ] as const)('reinstalls node_modules with %s', (manager, command) => {
    expect(restoreHint(rule('node_modules'), manager).command).toBe(command);
  });

  it('falls back to npm when no lockfile says otherwise', () => {
    expect(restoreHint(rule('node_modules'), null).command).toBe('npm install');
  });

  it('names the command for the other dependency folders', () => {
    expect(restoreHint(rule('Pods'), null).command).toBe('pod install');
    expect(restoreHint(rule('.dart_tool'), null).command).toBe('dart pub get');
    expect(restoreHint(rule('vendor'), null).command).toBe('composer install');
    expect(restoreHint(rule('.venv'), null).command).toBe('python -m venv .venv');
  });

  it('has no command for output and caches, only a sentence about how they come back', () => {
    for (const name of ['dist', '.next', '.turbo', 'coverage']) {
      const hint = restoreHint(rule(name), 'pnpm');
      expect(hint.command, name).toBeNull();
      expect(hint.label.length, name).toBeGreaterThan(10);
    }
  });

  it('never uses an em dash in what the user reads', () => {
    for (const name of ['node_modules', 'Pods', '.venv', 'vendor', 'dist', '.turbo']) {
      const hint = restoreHint(rule(name), 'npm');
      expect(`${hint.label}${hint.command ?? ''}`).not.toContain(EM_DASH);
    }
  });
});
