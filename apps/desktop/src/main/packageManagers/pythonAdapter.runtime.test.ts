import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/** Pipfile projects, the Python version a project asks for, and what goes up for alerts. */

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

const feedState = vi.hoisted(() => ({ python: '3.15.2' as string | null }));

vi.mock('./runtimeFeeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtimeFeeds')>();
  return { ...actual, runtimeFeeds: { python: async () => feedState.python } };
});

const { pythonAdapter } = await import('./pythonAdapter');

const has = { installedVersion: async () => null };
let root = '';

beforeEach(() => {
  root = tempDir('runova-python-runtime-');
  cliState.calls = [];
  cliState.handler = () => ({});
  feedState.python = '3.15.2';
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function runtimeRequest(overrides: Partial<RuntimeUpdateRequest>): RuntimeUpdateRequest {
  return {
    ecosystem: 'python',
    source: 'requires-python',
    kind: 'python',
    manifestPath: join(root, 'pyproject.toml'),
    targetVersion: '3.15.2',
    ...overrides,
  };
}

describe('Pipfile projects', () => {
  const PIPFILE = `[[source]]
url = "https://pypi.org/simple"
name = "pypi"

[packages]
requests = "==2.31.0"
rich = "*"
flask = { version = ">=2.0", extras = ["async"] }
local = { path = "." }
forked = { git = "https://example.com/forked.git" }

[dev-packages]
black = "==24.0.0"

[requires]
python_version = "3.11"
`;
  const LOCK = JSON.stringify({
    default: {
      requests: { version: '==2.31.0' },
      rich: { version: '==13.0.0' },
      flask: { version: '==2.1.0', extras: ['async'] },
    },
    develop: { black: { version: '==24.0.0' } },
  });
  const manifestPath = () => join(root, 'Pipfile');

  it('is detected', async () => {
    writeTree(root, { 'api/Pipfile': PIPFILE });
    await expect(pythonAdapter.detect(root)).resolves.toBe(true);
  });

  it('lists packages at their locked versions under Pipenv', async () => {
    writeTree(root, { Pipfile: PIPFILE, 'Pipfile.lock': LOCK });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.manager).toBe('pipenv');
    expect(section.packages.map((p) => [p.name, p.currentVersion, p.isDev, p.isInstalled])).toEqual(
      [
        ['black', '24.0.0', true, true],
        ['flask', '2.1.0', false, true],
        ['requests', '2.31.0', false, true],
        ['rich', '13.0.0', false, true],
      ],
    );
  });

  it('survives a lock file that is not JSON', async () => {
    writeTree(root, { Pipfile: PIPFILE, 'Pipfile.lock': 'nope' });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'rich')?.currentVersion).toBe('any');
  });

  it('installs with the same operators and puts dev packages under --dev', async () => {
    writeTree(root, { Pipfile: PIPFILE, 'Pipfile.lock': LOCK });

    const result = await pythonAdapter.updatePackages(
      root,
      [
        {
          ecosystem: 'python',
          name: 'requests',
          targetVersion: '2.32.0',
          manifestPath: manifestPath(),
        },
        {
          ecosystem: 'python',
          name: 'flask',
          targetVersion: '3.1.0',
          manifestPath: manifestPath(),
        },
        {
          ecosystem: 'python',
          name: 'black',
          targetVersion: '24.8.0',
          manifestPath: manifestPath(),
        },
      ],
      () => undefined,
    );

    expect(result.ok).toBe(true);
    expect(cliState.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['pipenv', 'install', 'requests==2.32.0', 'flask[async]>=3.1'],
      ['pipenv', 'install', '--dev', 'black==24.8.0'],
    ]);
  });

  it('only refreshes a package declared as any version', async () => {
    writeTree(root, { Pipfile: PIPFILE, 'Pipfile.lock': LOCK });

    await pythonAdapter.updatePackages(
      root,
      [
        {
          ecosystem: 'python',
          name: 'rich',
          targetVersion: '14.0.0',
          manifestPath: manifestPath(),
        },
      ],
      () => undefined,
    );

    expect(cliState.calls.map((c) => c.args)).toEqual([['update', 'rich']]);
  });

  it('explains a missing Pipenv', async () => {
    writeTree(root, { Pipfile: PIPFILE });
    cliState.handler = () => ({ notFound: true });

    const result = await pythonAdapter.updatePackages(
      root,
      [
        {
          ecosystem: 'python',
          name: 'requests',
          targetVersion: '2.32.0',
          manifestPath: manifestPath(),
        },
      ],
      () => undefined,
    );

    expect(result.results[0].message).toBe(
      'Install Pipenv and add it to PATH to update these packages.',
    );
  });
});

describe('the Python version a project asks for', () => {
  it('reads requires-python and keeps its form', async () => {
    writeTree(root, {
      'pyproject.toml': '[project]\nname = "d"\nrequires-python = ">=3.11"\ndependencies = ["a"]\n',
    });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.toolchain).toBeNull();
    expect(section.runtimes).toEqual([
      {
        kind: 'python',
        source: 'requires-python',
        declared: '>=3.11',
        currentVersion: '3.11',
        latestVersion: '3.15.2',
        isOutdated: true,
        nextDeclared: '>=3.15',
        requires: null,
        manifestPath: join(root, 'pyproject.toml'),
        projectLabel: 'd',
      },
    ]);
  });

  it('keeps an upper bound the new version still fits under', async () => {
    writeTree(root, { 'pyproject.toml': '[project]\nrequires-python = ">=3.11,<4"\n' });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.runtimes[0].nextDeclared).toBe('>=3.15,<4');
  });

  it('reads Poetry python and keeps it out of the packages', async () => {
    writeTree(root, {
      'pyproject.toml': '[tool.poetry]\nname = "d"\n[tool.poetry.dependencies]\npython = "^3.11"\n',
    });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.packages).toEqual([]);
    expect(section.runtimes[0]).toMatchObject({
      source: 'poetry-python',
      declared: '^3.11',
      nextDeclared: '^3.15',
    });
  });

  it('reads Pipfile python_version', async () => {
    writeTree(root, { Pipfile: '[packages]\na = "==1.0"\n[requires]\npython_version = "3.11"\n' });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.runtimes[0]).toMatchObject({
      source: 'pipfile-python',
      declared: '3.11',
      nextDeclared: '3.15',
    });
  });

  it('reads .python-version next to a manifest, once per folder', async () => {
    writeTree(root, {
      '.python-version': '3.12.1\n',
      'requirements.txt': 'a==1.0\n',
      'requirements-dev.txt': 'b==1.0\n',
    });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.runtimes).toHaveLength(1);
    expect(section.runtimes[0]).toMatchObject({
      source: 'python-version-file',
      declared: '3.12.1',
      nextDeclared: '3.15.2',
    });
  });

  it.each(['pypy3.10\n', '3.11\n3.12\n', 'system\n'])(
    'leaves out a .python-version of %j',
    async (content) => {
      writeTree(root, { '.python-version': content, 'requirements.txt': 'a==1.0\n' });

      const [section] = await pythonAdapter.listPackages(root);

      expect(section.runtimes).toEqual([]);
    },
  );

  it('shows the latest as unknown when the feed is down', async () => {
    feedState.python = null;
    writeTree(root, { 'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n' });

    const [section] = await pythonAdapter.listPackages(root);

    expect(section.runtimes[0]).toMatchObject({ latestVersion: null, isOutdated: false });
  });

  it('adds a section for a project that only names a Python version', async () => {
    writeTree(root, { 'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n' });

    await expect(pythonAdapter.listPackages(root)).resolves.toHaveLength(1);
  });

  it('writes the new value and relocks a uv project', async () => {
    const source = '[project]\r\nrequires-python = ">=3.11" # floor\r\n';
    writeTree(root, { 'pyproject.toml': source, 'uv.lock': '' });

    const result = await pythonAdapter.updateRuntime(root, runtimeRequest({}), has);

    expect(result).toEqual({ ok: true, message: 'Updated >=3.11 to >=3.15.' });
    expect(readFileSync(join(root, 'pyproject.toml'), 'utf-8')).toBe(
      source.replace('>=3.11', '>=3.15'),
    );
    expect(cliState.calls).toEqual([{ command: 'uv', args: ['lock'], cwd: root }]);
  });

  it('reports a uv lock that fails after the value is written', async () => {
    writeTree(root, { 'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n', 'uv.lock': '' });
    cliState.handler = () => ({ code: 1, stderr: 'No solution' });

    const result = await pythonAdapter.updateRuntime(root, runtimeRequest({}), has);

    expect(result).toEqual({
      ok: false,
      message: 'Updated >=3.11 to >=3.15. Then uv lock failed: No solution',
    });
  });

  it('says what is left to do for Poetry rather than risk rewriting its whole lock', async () => {
    writeTree(root, {
      'pyproject.toml': '[tool.poetry]\n[tool.poetry.dependencies]\npython = "^3.11"\n',
      'poetry.lock': '',
    });

    const result = await pythonAdapter.updateRuntime(
      root,
      runtimeRequest({ source: 'poetry-python' }),
      has,
    );

    expect(result).toEqual({
      ok: true,
      message: 'Updated ^3.11 to ^3.15. Run poetry lock to bring the lock file in line.',
    });
    expect(cliState.calls).toEqual([]);
  });

  it('writes .python-version with its own line ending', async () => {
    writeTree(root, { '.python-version': '3.12.1\r\n', 'requirements.txt': 'a==1.0\n' });
    const manifestPath = join(root, '.python-version');

    const result = await pythonAdapter.updateRuntime(
      root,
      runtimeRequest({ source: 'python-version-file', manifestPath }),
      has,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(manifestPath, 'utf-8')).toBe('3.15.2\r\n');
  });
});

describe('readInventory', () => {
  it('sends locked, pinned and lowest allowed versions under pypi, and no network is used', async () => {
    writeTree(root, {
      'requirements.txt': 'pinned==1.2.3\nranged>=2.0,<3\nloose\n',
      'svc/pyproject.toml': '[project]\nname = "s"\ndependencies = ["locked>=1.0"]\n',
      'svc/uv.lock': '[[package]]\nname = "locked"\nversion = "1.4.0"\n',
    });
    const requests = stubRegistry({});

    const inventory = await pythonAdapter.readInventory(root);

    expect(inventory).toEqual([
      { ecosystem: 'pypi', name: 'locked', version: '1.4.0', dev: false },
      { ecosystem: 'pypi', name: 'pinned', version: '1.2.3', dev: false },
      { ecosystem: 'pypi', name: 'ranged', version: '2.0', dev: false },
    ]);
    expect(requests).toEqual([]);
  });

  it('marks dev packages', async () => {
    writeTree(root, { 'requirements-dev.txt': 'pytest==8.0\n' });

    expect(await pythonAdapter.readInventory(root)).toEqual([
      { ecosystem: 'pypi', name: 'pytest', version: '8.0', dev: true },
    ]);
  });
});
