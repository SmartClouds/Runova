import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/** The Rust version a project asks for, and what goes up for dependency alerts. */

const feedState = vi.hoisted(() => ({ rust: '1.99.1' as string | null }));

vi.mock('./runtimeFeeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtimeFeeds')>();
  return { ...actual, runtimeFeeds: { rust: async () => feedState.rust } };
});

const { rustAdapter } = await import('./rustAdapter');

const has = { installedVersion: async () => null };
let root = '';

beforeEach(() => {
  root = tempDir('runova-rust-runtime-');
  feedState.rust = '1.99.1';
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<RuntimeUpdateRequest>): RuntimeUpdateRequest {
  return {
    ecosystem: 'rust',
    source: 'rust-version',
    kind: 'rust',
    manifestPath: join(root, 'Cargo.toml'),
    targetVersion: '1.99.1',
    ...overrides,
  };
}

describe('the Rust version a project asks for', () => {
  it('reads rust-version at its own precision', async () => {
    writeTree(root, { 'Cargo.toml': '[package]\nname = "d"\nrust-version = "1.75"\n' });

    const [section] = await rustAdapter.listPackages(root);

    expect(section.runtimes).toEqual([
      {
        kind: 'rust',
        source: 'rust-version',
        declared: '1.75',
        currentVersion: '1.75',
        latestVersion: '1.99.1',
        isOutdated: true,
        nextDeclared: '1.99',
        requires: null,
        manifestPath: join(root, 'Cargo.toml'),
        projectLabel: 'd',
      },
    ]);
  });

  it('reads it from a workspace and skips a member that inherits it', async () => {
    writeTree(root, {
      'Cargo.toml': '[workspace]\n[workspace.package]\nrust-version = "1.80.0"\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\nrust-version.workspace = true\n',
    });

    const [section] = await rustAdapter.listPackages(root);

    expect(section.runtimes.map((t) => t.declared)).toEqual(['1.80.0']);
    expect(section.runtimes[0].nextDeclared).toBe('1.99.1');
  });

  it('reads a pinned toolchain from rust-toolchain.toml', async () => {
    writeTree(root, {
      'Cargo.toml': '[package]\nname = "d"\n',
      'rust-toolchain.toml': '[toolchain]\nchannel = "1.80.0"\ncomponents = ["clippy"]\n',
    });

    const [section] = await rustAdapter.listPackages(root);

    expect(section.runtimes[0]).toMatchObject({
      source: 'rust-toolchain',
      manifestPath: join(root, 'rust-toolchain.toml'),
      nextDeclared: '1.99.1',
    });
  });

  it('reads the older plain rust-toolchain file', async () => {
    writeTree(root, { 'Cargo.toml': '[package]\nname = "d"\n', 'rust-toolchain': '1.80.0\n' });

    const [section] = await rustAdapter.listPackages(root);

    expect(section.runtimes[0]).toMatchObject({ source: 'rust-toolchain', declared: '1.80.0' });
  });

  it.each(['[toolchain]\nchannel = "stable"\n', '[toolchain]\nchannel = "nightly-2026-01-01"\n'])(
    'leaves out a channel that already follows releases: %j',
    async (content) => {
      writeTree(root, { 'Cargo.toml': '[package]\nname = "d"\n', 'rust-toolchain.toml': content });

      await expect(rustAdapter.listPackages(root)).resolves.toEqual([]);
    },
  );

  it('writes rust-version and leaves the rest of the file alone', async () => {
    const source = '[package]\r\nname = "d" # x\r\nrust-version = "1.75"\r\n';
    writeTree(root, { 'Cargo.toml': source });

    const result = await rustAdapter.updateRuntime(root, request({}), has);

    expect(result).toEqual({ ok: true, message: 'Updated 1.75 to 1.99.' });
    expect(readFileSync(join(root, 'Cargo.toml'), 'utf-8')).toBe(source.replace('1.75', '1.99'));
  });

  it('writes both toolchain file forms', async () => {
    writeTree(root, {
      'a/Cargo.toml': '[package]\nname = "a"\n',
      'a/rust-toolchain.toml': '[toolchain]\nchannel = "1.80.0"\n',
      'b/Cargo.toml': '[package]\nname = "b"\n',
      'b/rust-toolchain': '1.80.0\n',
    });
    const toml = join(root, 'a', 'rust-toolchain.toml');
    const plain = join(root, 'b', 'rust-toolchain');

    await rustAdapter.updateRuntime(
      root,
      request({ source: 'rust-toolchain', manifestPath: toml }),
      has,
    );
    await rustAdapter.updateRuntime(
      root,
      request({ source: 'rust-toolchain', manifestPath: plain }),
      has,
    );

    expect(readFileSync(toml, 'utf-8')).toContain('channel = "1.99.1"');
    expect(readFileSync(plain, 'utf-8')).toBe('1.99.1\n');
  });
});

describe('readInventory', () => {
  it('sends crates by their real name under crates, and nothing else', async () => {
    writeTree(root, {
      'Cargo.toml': `[package]
name = "d"
[dependencies]
serde = "1"
alias = { package = "real-crate", version = "2" }
local = { path = "../local" }
corp = { version = "1.0.0", registry = "corp" }
tricky = ">=1, <2"
[dev-dependencies]
insta = "1.2.0"
`,
      'Cargo.lock': '[[package]]\nname = "serde"\nversion = "1.0.100"\n',
    });
    const requests = stubRegistry({});

    const inventory = await rustAdapter.readInventory(root);

    expect(inventory).toEqual([
      { ecosystem: 'crates', name: 'insta', version: '1.2.0', dev: true },
      { ecosystem: 'crates', name: 'real-crate', version: '2', dev: false },
      { ecosystem: 'crates', name: 'serde', version: '1.0.100', dev: false },
    ]);
    expect(requests).toEqual([]);
  });
});
