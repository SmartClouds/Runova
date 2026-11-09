import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/** The Swift version a project asks for, and what goes up for dependency alerts. */

const feedState = vi.hoisted(() => ({ swift: '6.2.1' as string | null }));

vi.mock('./runtimeFeeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtimeFeeds')>();
  return { ...actual, runtimeFeeds: { swift: async () => feedState.swift } };
});

const { swiftAdapter } = await import('./swiftAdapter');

const has = { installedVersion: async () => null };
let root = '';

beforeEach(() => {
  root = tempDir('runova-swift-runtime-');
  feedState.swift = '6.2.1';
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<RuntimeUpdateRequest>): RuntimeUpdateRequest {
  return {
    ecosystem: 'swift',
    source: 'swift-tools',
    kind: 'swift',
    manifestPath: join(root, 'Package.swift'),
    targetVersion: '6.2.1',
    ...overrides,
  };
}

const PBX = (versions: string[]) => versions.map((v) => `\t\t\t\tSWIFT_VERSION = ${v};\n`).join('');

describe('the Swift version a project asks for', () => {
  it.each([
    '// swift-tools-version:5.9',
    '// swift-tools-version: 5.9',
    '//swift-tools-version:5.9',
  ])('reads %s', async (line) => {
    writeTree(root, { 'Package.swift': `${line}\nlet package = Package(name: "D")\n` });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section).toMatchObject({ ecosystem: 'swift', manager: 'spm' });
    expect(section.runtimes).toEqual([
      {
        kind: 'swift',
        source: 'swift-tools',
        declared: '5.9',
        currentVersion: '5.9',
        latestVersion: '6.2.1',
        isOutdated: true,
        nextDeclared: '6.2',
        requires: null,
        manifestPath: join(root, 'Package.swift'),
        projectLabel: root.split(/[\\/]/).at(-1),
      },
    ]);
  });

  it('only reads the tools version from the top of the file', async () => {
    writeTree(root, {
      'Package.swift': 'let package = Package(name: "D")\n// swift-tools-version:5.9\n',
    });

    await expect(swiftAdapter.listPackages(root)).resolves.toEqual([]);
  });

  it('writes the tools version and nothing else', async () => {
    const source = '// swift-tools-version:5.9\r\nimport PackageDescription\r\n';
    writeTree(root, { 'Package.swift': source });

    const result = await swiftAdapter.updateRuntime(root, request({}), has);

    expect(result).toEqual({ ok: true, message: 'Updated 5.9 to 6.2.' });
    expect(readFileSync(join(root, 'Package.swift'), 'utf-8')).toBe(source.replace('5.9', '6.2'));
  });

  it('reports the language mode of an Xcode project once, compared by major version', async () => {
    writeTree(root, {
      'ios/Demo.xcodeproj/project.pbxproj': PBX(['5.0', '5.0']),
    });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.runtimes).toEqual([
      expect.objectContaining({
        source: 'swift-language',
        declared: '5.0',
        latestVersion: '6.0',
        isOutdated: true,
        // Moving language mode is a migration, so a button should not do it blind.
        nextDeclared: null,
        projectLabel: 'Demo',
      }),
    ]);
  });

  it('calls an Xcode project on the newest language mode current', async () => {
    writeTree(root, { 'Demo.xcodeproj/project.pbxproj': PBX(['6.0']) });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.runtimes[0].isOutdated).toBe(false);
  });

  it('refuses to rewrite the language mode', async () => {
    const manifestPath = join(root, 'Demo.xcodeproj', 'project.pbxproj');
    writeTree(root, { 'Demo.xcodeproj/project.pbxproj': PBX(['5.0']) });

    const result = await swiftAdapter.updateRuntime(
      root,
      request({ source: 'swift-language', manifestPath, targetVersion: '6.0' }),
      has,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Update with AI');
    expect(readFileSync(manifestPath, 'utf-8')).toBe(PBX(['5.0']));
  });
});

describe('readInventory', () => {
  it('sends Swift packages by repository address and pods by their root name', async () => {
    writeTree(root, {
      'Package.swift': `let package = Package(dependencies: [
  .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.8.0"),
  .package(url: "git@github.com:acme/Private.git", from: "1.0.0"),
  .package(url: "ext::sh -c x", from: "1.0.0"),
])`,
      'ios/Podfile': `pod 'Firebase/Analytics', '~> 10.0'
pod 'Firebase/Core', '~> 10.0'
pod 'Loose'
`,
      'ios/Podfile.lock': 'PODS:\n  - Firebase/Analytics (10.5.0)\n  - Firebase/Core (10.5.0)\n',
    });
    const requests = stubRegistry({});

    const inventory = await swiftAdapter.readInventory(root);

    expect(inventory).toEqual([
      { ecosystem: 'pods', name: 'Firebase', version: '10.5.0', dev: false },
      {
        ecosystem: 'swift',
        name: 'github.com/acme/Private',
        version: '1.0.0',
        dev: false,
      },
      {
        ecosystem: 'swift',
        name: 'github.com/Alamofire/Alamofire',
        version: '5.8.0',
        dev: false,
      },
    ]);
    expect(requests).toEqual([]);
  });
});
