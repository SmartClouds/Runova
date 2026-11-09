import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/**
 * Cargo requirements are often looser than the lock (`serde = "1"`), so some updates only move
 * Cargo.lock and others have to rewrite Cargo.toml. Getting that split right is most of this file.
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

const { rustAdapter, crateIndexPath } = await import('./rustAdapter');

function index(name: string, versions: (string | [string, boolean])[]): Record<string, string> {
  const lines = versions.map((v) =>
    JSON.stringify(
      typeof v === 'string' ? { name, vers: v, yanked: false } : { name, vers: v[0], yanked: v[1] },
    ),
  );
  return { [`https://index.crates.io/${crateIndexPath(name)}`]: lines.join('\n') };
}

const lock = (entries: [string, string][]) =>
  `version = 4\n\n${entries.map(([n, v]) => `[[package]]\nname = "${n}"\nversion = "${v}"\n`).join('\n')}`;

let root = '';

beforeEach(() => {
  root = tempDir('runova-rust-adapter-');
  cliState.calls = [];
  cliState.handler = () => ({});
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<PackageUpdateRequest> = {}): PackageUpdateRequest {
  return {
    ecosystem: 'rust',
    name: 'serde',
    targetVersion: '1.0.200',
    manifestPath: join(root, 'Cargo.toml'),
    ...overrides,
  };
}

describe('crateIndexPath', () => {
  it.each([
    ['a', '1/a'],
    ['ab', '2/ab'],
    ['abc', '3/a/abc'],
    ['serde', 'se/rd/serde'],
    ['Inflector', 'in/fl/inflector'],
  ])('puts %s at %s', (name, path) => {
    expect(crateIndexPath(name)).toBe(path);
  });
});

describe('detect', () => {
  it('finds a Cargo.toml, also a nested one', async () => {
    writeTree(root, { 'apps/core/Cargo.toml': '' });
    await expect(rustAdapter.detect(root)).resolves.toBe(true);
  });

  it.each(['target', 'vendor', 'node_modules'])('ignores what sits under %s', async (dir) => {
    writeTree(root, { [`${dir}/Cargo.toml`]: '' });
    await expect(rustAdapter.detect(root)).resolves.toBe(false);
  });
});

describe('listing', () => {
  it('reads every dependency table and form', async () => {
    writeTree(root, {
      'Cargo.toml': `[package]
name = "demo"

[dependencies]
serde = { version = "1.0.100", features = ["derive"] }
anyhow = "1"
renamed = { package = "real-crate", version = "2.0" }

[dependencies.tokio]
version = "1.30"
features = ["full"]

[dev-dependencies]
insta = "=1.2.0"

[build-dependencies]
cc = "~1.0"

[target.'cfg(windows)'.dependencies]
winapi = "0.3.9"
`,
      'Cargo.lock': lock([
        ['serde', '1.0.100'],
        ['anyhow', '1.0.50'],
        ['real-crate', '2.0.1'],
        ['tokio', '1.30.0'],
        ['insta', '1.2.0'],
        ['cc', '1.0.70'],
        ['winapi', '0.3.9'],
      ]),
    });

    const [section] = await rustAdapter.listPackages(root);

    expect(section).toMatchObject({ ecosystem: 'rust', manager: 'cargo', status: 'ok' });
    expect(section.packages.map((p) => [p.name, p.currentVersion, p.isDev])).toEqual([
      ['anyhow', '1.0.50', false],
      ['cc', '1.0.70', false],
      ['insta', '1.2.0', true],
      ['renamed', '2.0.1', false],
      ['serde', '1.0.100', false],
      ['tokio', '1.30.0', false],
      ['winapi', '0.3.9', false],
    ]);
  });

  it('leaves out path, git and inherited workspace entries', async () => {
    writeTree(root, {
      'Cargo.toml': `[package]
name = "demo"
[dependencies]
one = { path = "../one" }
two = { git = "https://example.com/two.git" }
three = { workspace = true }
four.workspace = true
`,
    });

    await expect(rustAdapter.listPackages(root)).resolves.toEqual([]);
  });

  it('never compares a crate from another registry', async () => {
    writeTree(root, {
      'Cargo.toml':
        '[package]\nname = "d"\n[dependencies]\ninternal = { version = "1.0.0", registry = "corp" }\n',
    });

    const requests = stubRegistry({});
    const [section] = await rustAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ name: 'internal', isOutdated: false });
    expect(requests).toEqual([]);
  });

  it('lists a workspace root under its folder and finds the lock for its members', async () => {
    writeTree(root, {
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\nserde = "1"\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\n[dependencies]\nhex = "0.4"\n',
      'Cargo.lock': lock([
        ['serde', '1.0.100'],
        ['hex', '0.4.2'],
      ]),
    });
    stubRegistry({ ...index('serde', ['1.0.100']), ...index('hex', ['0.4.3']) });

    const [section] = await rustAdapter.listPackages(root);
    const byName = Object.fromEntries(section.packages.map((p) => [p.name, p]));

    expect(byName.hex).toMatchObject({
      projectLabel: 'a',
      currentVersion: '0.4.2',
      isOutdated: true,
    });
    expect(byName.serde.isOutdated).toBe(false);
  });

  it('picks the highest unyanked release', async () => {
    writeTree(root, {
      'Cargo.toml': '[package]\nname = "d"\n[dependencies]\nserde = "1.0.1"\n',
      'Cargo.lock': lock([['serde', '1.0.1']]),
    });
    stubRegistry(index('serde', ['1.0.1', '1.0.5', ['1.0.9', true], '2.0.0-alpha.1']));

    const [section] = await rustAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ latestVersion: '1.0.5', isOutdated: true });
  });

  it('tells two locked versions of one crate apart by the requirement', async () => {
    writeTree(root, {
      'Cargo.toml': '[package]\nname = "d"\n[dependencies]\nrand = "0.8"\n',
      'Cargo.lock': lock([
        ['rand', '0.7.3'],
        ['rand', '0.8.5'],
        ['rand', '0.9.0'],
      ]),
    });

    const [section] = await rustAdapter.listPackages(root);

    expect(section.packages[0].currentVersion).toBe('0.8.5');
  });

  it('shows the requirement without a lock, and does not flag what it already allows', async () => {
    writeTree(root, { 'Cargo.toml': '[package]\nname = "d"\n[dependencies]\nserde = "1"\n' });
    stubRegistry(index('serde', ['1.0.200']));

    const [section] = await rustAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({
      currentVersion: '1',
      latestVersion: '1.0.200',
      isOutdated: false,
      isInstalled: false,
    });
  });

  it('will not move a compound requirement', async () => {
    writeTree(root, {
      'Cargo.toml': '[package]\nname = "d"\n[dependencies]\nserde = ">=1, <2"\n',
      'Cargo.lock': lock([['serde', '1.0.0']]),
    });
    stubRegistry(index('serde', ['1.0.200']));

    const [section] = await rustAdapter.listPackages(root);

    expect(section.packages[0].isOutdated).toBe(false);
  });

  it('keeps going when the index is unreachable, and says so', async () => {
    writeTree(root, {
      'Cargo.toml': '[package]\nname = "d"\n[dependencies]\nserde = "1.0.1"\n',
    });
    stubRegistry({ [`https://index.crates.io/${crateIndexPath('serde')}`]: null });

    const [section] = await rustAdapter.listPackages(root);

    expect(section.packages[0].latestVersion).toBeNull();
    expect(section.message).toContain('Could not reach');
  });
});

describe('updating', () => {
  it('rewrites the requirement in the same style and refreshes the lock', async () => {
    const source =
      '[dependencies]\r\nserde = { version = "1.0.100", features = ["derive"] }\r\ntokio = "=1.30.0" # exact\r\nhex = "0.4"\r\n';
    writeTree(root, {
      'Cargo.toml': source,
      'Cargo.lock': lock([
        ['serde', '1.0.100'],
        ['tokio', '1.30.0'],
        ['hex', '0.4.3'],
      ]),
    });

    const result = await rustAdapter.updatePackages(
      root,
      [
        request(),
        request({ name: 'tokio', targetVersion: '1.40.0' }),
        request({ name: 'hex', targetVersion: '0.5.1' }),
      ],
      () => undefined,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'Cargo.toml'), 'utf-8')).toBe(
      '[dependencies]\r\nserde = { version = "1.0.200", features = ["derive"] }\r\ntokio = "=1.40.0" # exact\r\nhex = "0.5"\r\n',
    );
    expect(cliState.calls).toEqual([
      { command: 'cargo', args: ['update', '--workspace'], cwd: root },
    ]);
  });

  it('only moves the lock when the requirement already allows the new version', async () => {
    const source = '[dependencies]\nserde = "1"\n';
    writeTree(root, { 'Cargo.toml': source, 'Cargo.lock': lock([['serde', '1.0.100']]) });

    await rustAdapter.updatePackages(root, [request()], () => undefined);

    expect(readFileSync(join(root, 'Cargo.toml'), 'utf-8')).toBe(source);
    expect(cliState.calls.map((c) => c.args)).toEqual([
      ['update', '-p', 'serde@1.0.100', '--precise', '1.0.200'],
    ]);
  });

  it('uses the real crate name of a renamed dependency', async () => {
    writeTree(root, {
      'Cargo.toml': '[dependencies]\nalias = { package = "real-crate", version = "2" }\n',
      'Cargo.lock': lock([['real-crate', '2.0.1']]),
    });

    await rustAdapter.updatePackages(
      root,
      [request({ name: 'alias', targetVersion: '2.1.0' })],
      () => undefined,
    );

    expect(cliState.calls[0].args).toEqual([
      'update',
      '-p',
      'real-crate@2.0.1',
      '--precise',
      '2.1.0',
    ]);
  });

  it('updates a shared workspace requirement in the root manifest', async () => {
    writeTree(root, {
      'Cargo.toml': '[workspace]\n[workspace.dependencies]\nhex = "0.4"\n',
      'Cargo.lock': lock([['hex', '0.4.3']]),
    });

    await rustAdapter.updatePackages(
      root,
      [request({ name: 'hex', targetVersion: '0.5.0' })],
      () => undefined,
    );

    expect(readFileSync(join(root, 'Cargo.toml'), 'utf-8')).toContain('hex = "0.5"');
  });

  it('runs cargo in the member that was changed, finding the root lock', async () => {
    writeTree(root, {
      'Cargo.lock': lock([['hex', '0.4.3']]),
      'crates/a/Cargo.toml': '[dependencies]\nhex = "0.4"\n',
    });

    await rustAdapter.updatePackages(
      root,
      [
        request({
          name: 'hex',
          targetVersion: '0.5.0',
          manifestPath: join(root, 'crates', 'a', 'Cargo.toml'),
        }),
      ],
      () => undefined,
    );

    expect(cliState.calls[0].cwd).toBe(join(root, 'crates', 'a'));
  });

  it('writes the manifest and runs nothing for a project with no lock', async () => {
    writeTree(root, { 'Cargo.toml': '[dependencies]\nserde = "1.0.1"\n' });

    const result = await rustAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.ok).toBe(true);
    expect(cliState.calls).toEqual([]);
  });

  it('says what happened when cargo is missing after the manifest was written', async () => {
    writeTree(root, {
      'Cargo.toml': '[dependencies]\nserde = "1.0.1"\n',
      'Cargo.lock': lock([['serde', '1.0.1']]),
    });
    cliState.handler = () => ({ notFound: true });

    const result = await rustAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toBe(
      'Updated Cargo.toml, but cargo is not on PATH, so Cargo.lock was not refreshed.',
    );
  });

  it('surfaces a failing cargo', async () => {
    writeTree(root, {
      'Cargo.toml': '[dependencies]\nserde = "1"\n',
      'Cargo.lock': lock([['serde', '1.0.1']]),
    });
    cliState.handler = () => ({ code: 101, stderr: 'failed to select a version' });

    const result = await rustAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.results[0]).toMatchObject({ ok: false, message: 'failed to select a version' });
  });

  it('reports a dependency the manifest no longer has', async () => {
    writeTree(root, { 'Cargo.toml': '[dependencies]\nother = "1"\n' });

    const result = await rustAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toContain('serde');
  });
});
