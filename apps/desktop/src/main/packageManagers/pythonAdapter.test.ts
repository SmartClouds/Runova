import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/**
 * A Python project can declare its packages in four places (requirements files, PEP 621 arrays,
 * dependency groups and Poetry tables) and be managed by pip, uv or Poetry. Which one it is decides
 * how an update is carried out, so these tests go through the real file shapes each tool writes.
 */

interface CliAnswer {
  stdout?: string;
  stderr?: string;
  code?: number;
  notFound?: boolean;
}

const cliState = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; cwd: string }[],
  handler: (_command: string, _args: string[]): CliAnswer => ({}),
}));

vi.mock('./execUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./execUtils')>();
  return {
    ...actual,
    runCli: async (command: string, args: string[], cwd: string) => {
      cliState.calls.push({ command, args, cwd });
      const answer = cliState.handler(command, args);
      if (answer.notFound) throw new actual.CliNotFoundError(`${command} is not available on PATH`);
      return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', code: answer.code ?? 0 };
    },
  };
});

const { pythonAdapter } = await import('./pythonAdapter');

const pypi = (name: string) => `https://pypi.org/pypi/${name}/json`;
const release = (version: string) => JSON.stringify({ info: { version } });

let root = '';

beforeEach(() => {
  root = tempDir('runova-python-adapter-');
  cliState.calls = [];
  cliState.handler = () => ({});
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<PackageUpdateRequest> = {}): PackageUpdateRequest {
  return {
    ecosystem: 'python',
    name: 'requests',
    targetVersion: '2.32.0',
    manifestPath: join(root, 'requirements.txt'),
    ...overrides,
  };
}

describe('detect', () => {
  it.each(['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'svc/pyproject.toml'])(
    'finds %s',
    async (file) => {
      writeTree(root, { [file]: '' });
      await expect(pythonAdapter.detect(root)).resolves.toBe(true);
    },
  );

  it.each(['.venv', 'venv', 'site-packages', 'node_modules', '__pycache__'])(
    'ignores what sits under %s',
    async (dir) => {
      writeTree(root, { [`${dir}/requirements.txt`]: 'requests==1.0\n' });
      await expect(pythonAdapter.detect(root)).resolves.toBe(false);
    },
  );

  it('is false for a folder without Python manifests', async () => {
    writeTree(root, { 'package.json': '{}' });
    await expect(pythonAdapter.detect(root)).resolves.toBe(false);
  });
});

describe('listing a requirements file', () => {
  it('reads pins and ranges and skips everything that is not a package', async () => {
    writeTree(root, {
      'requirements.txt': `# web
-r base.txt
--index-url https://pypi.example/simple
requests==2.31.0  # http
flask>=3.0.1,<4
Django[argon2]~=5.0.1 ; python_version >= "3.10"
gitpkg @ git+https://example.com/x.git
-e ./local
`,
    });
    stubRegistry({
      [pypi('requests')]: release('2.32.0'),
      [pypi('flask')]: release('3.0.1'),
      [pypi('Django')]: release('5.1.0'),
    });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section).toMatchObject({ ecosystem: 'python', manager: 'pip', toolchain: null });
    expect(
      section.packages.map((p) => [p.name, p.currentVersion, p.latestVersion, p.isOutdated]),
    ).toEqual([
      ['Django', '~=5.0.1', '5.1.0', true],
      ['flask', '>=3.0.1,<4', '3.0.1', false],
      ['requests', '2.31.0', '2.32.0', true],
    ]);
  });

  it('counts only an exact pin as installed', async () => {
    writeTree(root, { 'requirements.txt': 'a==1.0\nb>=1.0\n' });
    stubRegistry({ [pypi('a')]: release('1.0'), [pypi('b')]: release('1.0') });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.packages.map((p) => p.isInstalled)).toEqual([true, false]);
  });

  it('marks packages from a dev or test requirements file as dev', async () => {
    writeTree(root, {
      'requirements-dev.txt': 'pytest==8.0\n',
      'requirements.txt': 'a==1.0\n',
    });

    const [section] = await pythonAdapter.listPackages(root);
    const dev = Object.fromEntries(section.packages.map((p) => [p.name, p.isDev]));

    expect(dev).toEqual({ a: false, pytest: true });
  });

  it('labels each row by the file it came from', async () => {
    writeTree(root, { 'requirements-dev.txt': 'a==1.0\n', 'api/requirements.txt': 'b==1.0\n' });

    const [section] = await pythonAdapter.listPackages(root);

    expect(new Set(section.packages.map((p) => p.projectLabel))).toEqual(
      new Set(['requirements-dev.txt', join('api', 'requirements.txt')]),
    );
  });

  it('will not rewrite a line protected by a hash', async () => {
    writeTree(root, {
      'requirements.txt': 'requests==2.31.0 \\\n    --hash=sha256:abc\n',
    });
    stubRegistry({ [pypi('requests')]: release('2.32.0') });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ name: 'requests', isOutdated: false });
  });

  it('never offers a pre-release that PyPI reports for an all pre-release project', async () => {
    writeTree(root, { 'requirements.txt': 'a==1.0\n' });
    stubRegistry({ [pypi('a')]: release('2.0.0rc1') });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.packages[0].isOutdated).toBe(false);
  });

  it('leaves the latest unknown and says why when PyPI has no such package', async () => {
    writeTree(root, { 'requirements.txt': 'private-thing==1.0\n' });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ latestVersion: null, isOutdated: false });
    expect(section.message).toContain('could not be looked up');
  });

  it('notes that the environment still needs an install', async () => {
    writeTree(root, { 'requirements.txt': 'a==1.0\n' });
    stubRegistry({ [pypi('a')]: release('1.0') });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.message).toContain('pip install');
  });
});

describe('listing pyproject.toml', () => {
  it('reads PEP 621 dependencies, extras and dependency groups', async () => {
    writeTree(root, {
      'pyproject.toml': `[project]
name = "demo"
dependencies = ["httpx>=0.27.0", "rich"]

[project.optional-dependencies]
docs = ["mkdocs>=1.5"]

[dependency-groups]
lint = [{ include-group = "base" }, "ruff>=0.5"]
`,
    });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.manager).toBe('pip');
    expect(section.packages.map((p) => [p.name, p.isDev, p.projectLabel])).toEqual([
      ['httpx', false, 'demo'],
      ['mkdocs', false, 'demo'],
      ['rich', false, 'demo'],
      ['ruff', true, 'demo'],
    ]);
  });

  it('is managed by uv when uv.lock is there, and uses the locked versions', async () => {
    writeTree(root, {
      'pyproject.toml': '[project]\nname = "demo"\ndependencies = ["Foo_Bar>=1.0"]\n',
      'uv.lock': 'version = 1\n\n[[package]]\nname = "foo-bar"\nversion = "1.4.0"\n',
    });
    stubRegistry({ [pypi('Foo_Bar')]: release('1.5.0') });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.manager).toBe('uv');
    // uv writes normalized names, so foo-bar in the lock is Foo_Bar in the manifest.
    expect(section.packages[0]).toMatchObject({
      currentVersion: '1.4.0',
      latestVersion: '1.5.0',
      isOutdated: true,
      isInstalled: true,
    });
  });

  it('reads Poetry tables and leaves python, path and git entries out', async () => {
    writeTree(root, {
      'pyproject.toml': `[tool.poetry]
name = "demo"

[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"
rich = { version = "^13.0", extras = ["jupyter"] }
local = { path = "../local" }
forked = { git = "https://example.com/forked.git" }

[tool.poetry.group.test.dependencies]
pytest = "^8.0"
`,
      'poetry.lock':
        '[[package]]\nname = "requests"\nversion = "2.31.0"\n\n[[package]]\nname = "pytest"\nversion = "8.0.0"\n',
    });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.manager).toBe('poetry');
    expect(section.packages.map((p) => [p.name, p.currentVersion, p.isDev])).toEqual([
      ['pytest', '8.0.0', true],
      ['requests', '2.31.0', false],
      ['rich', '^13.0', false],
    ]);
  });

  it('adds no section for a pyproject that only configures tools', async () => {
    writeTree(root, { 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' });

    await expect(pythonAdapter.listPackages(root)).resolves.toEqual([]);
  });

  it('gives one section per manager when a repo mixes them', async () => {
    writeTree(root, {
      'a/requirements.txt': 'x==1.0\n',
      'b/pyproject.toml': '[project]\nname = "b"\ndependencies = ["y>=1"]\n',
      'b/uv.lock': '',
    });

    const sections = await pythonAdapter.listPackages(root);

    expect(sections.map((s) => s.manager).sort()).toEqual(['pip', 'uv']);
  });
});

describe('updating with pip', () => {
  it('rewrites the file in the style it was written, and leaves the rest alone', async () => {
    writeTree(root, {
      'requirements.txt':
        '# keep me\r\nrequests==2.31.0  # http\r\nflask>=3.0.1,<4\r\nDjango[argon2]~=5.0.1 ; python_version >= "3.10"\r\n',
    });

    const result = await pythonAdapter.updatePackages(
      root,
      [
        request(),
        request({ name: 'flask', targetVersion: '3.1.0' }),
        request({ name: 'django', targetVersion: '5.1.2' }),
      ],
      () => undefined,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'requirements.txt'), 'utf-8')).toBe(
      '# keep me\r\nrequests==2.32.0  # http\r\nflask>=3.1.0,<4\r\nDjango[argon2]~=5.1.2 ; python_version >= "3.10"\r\n',
    );
    expect(cliState.calls).toEqual([]);
  });

  it('moves an upper bound the new version would break', async () => {
    writeTree(root, { 'requirements.txt': 'flask>=2.0,<3\n' });

    await pythonAdapter.updatePackages(
      root,
      [request({ name: 'flask', targetVersion: '3.1.0' })],
      () => undefined,
    );

    expect(readFileSync(join(root, 'requirements.txt'), 'utf-8')).toBe('flask>=3.1,<4\n');
  });

  it('rewrites a PEP 621 array inside pyproject.toml', async () => {
    writeTree(root, {
      'pyproject.toml': '[project]\nname = "d"\ndependencies = [\n  "httpx>=0.27.0",\n]\n',
    });

    await pythonAdapter.updatePackages(
      root,
      [
        request({
          name: 'httpx',
          targetVersion: '0.28.1',
          manifestPath: join(root, 'pyproject.toml'),
        }),
      ],
      () => undefined,
    );

    expect(readFileSync(join(root, 'pyproject.toml'), 'utf-8')).toContain('"httpx>=0.28.1"');
  });

  it('reports a package the file no longer has', async () => {
    writeTree(root, { 'requirements.txt': 'other==1.0\n' });

    const result = await pythonAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toContain('requests');
  });
});

describe('updating with uv', () => {
  function uvProject(): void {
    writeTree(root, {
      'pyproject.toml': `[project]
name = "d"
dependencies = ["httpx>=0.27.0"]

[project.optional-dependencies]
docs = ["mkdocs>=1.5"]

[dependency-groups]
dev = ["pytest>=8.0"]
lint = ["ruff>=0.5"]
`,
      'uv.lock': '',
    });
  }
  const manifestPath = () => join(root, 'pyproject.toml');

  it('adds each package to the group it belongs to', async () => {
    uvProject();

    await pythonAdapter.updatePackages(
      root,
      [
        request({ name: 'httpx', targetVersion: '0.28.1', manifestPath: manifestPath() }),
        request({ name: 'mkdocs', targetVersion: '1.6.0', manifestPath: manifestPath() }),
        request({ name: 'pytest', targetVersion: '8.3.0', manifestPath: manifestPath() }),
        request({ name: 'ruff', targetVersion: '0.6.0', manifestPath: manifestPath() }),
      ],
      () => undefined,
    );

    expect(cliState.calls.map((c) => c.args)).toEqual([
      ['add', '--upgrade-package', 'httpx', 'httpx>=0.28.1'],
      ['add', '--optional', 'docs', '--upgrade-package', 'mkdocs', 'mkdocs>=1.6'],
      ['add', '--group', 'dev', '--upgrade-package', 'pytest', 'pytest>=8.3'],
      ['add', '--group', 'lint', '--upgrade-package', 'ruff', 'ruff>=0.6'],
    ]);
    expect(cliState.calls[0].command).toBe('uv');
    expect(cliState.calls[0].cwd).toBe(root);
  });

  it('explains a missing uv', async () => {
    uvProject();
    cliState.handler = () => ({ notFound: true });

    const result = await pythonAdapter.updatePackages(
      root,
      [request({ name: 'httpx', manifestPath: manifestPath() })],
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toBe(
      'Install uv and add it to PATH to update these packages.',
    );
  });

  it('surfaces the tail of a failed run', async () => {
    uvProject();
    cliState.handler = () => ({ code: 1, stderr: 'No solution found' });

    const result = await pythonAdapter.updatePackages(
      root,
      [request({ name: 'httpx', manifestPath: manifestPath() })],
      () => undefined,
    );

    expect(result.results[0]).toMatchObject({ ok: false, message: 'No solution found' });
  });
});

describe('updating with Poetry', () => {
  it('uses the group and keeps the constraint style and extras', async () => {
    writeTree(root, {
      'pyproject.toml': `[tool.poetry]
name = "d"
[tool.poetry.dependencies]
rich = { version = "^13.0", extras = ["jupyter"] }
[tool.poetry.group.test.dependencies]
pytest = "^8.0"
`,
      'poetry.lock': '',
    });
    const manifestPath = join(root, 'pyproject.toml');

    await pythonAdapter.updatePackages(
      root,
      [
        request({ name: 'rich', targetVersion: '13.9.1', manifestPath }),
        request({ name: 'pytest', targetVersion: '8.3.2', manifestPath }),
      ],
      () => undefined,
    );

    expect(cliState.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['poetry', 'add', 'rich[jupyter]@^13.9'],
      ['poetry', 'add', '--group', 'test', 'pytest@^8.3'],
    ]);
  });
});
