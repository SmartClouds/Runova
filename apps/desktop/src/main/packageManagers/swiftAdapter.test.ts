import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest } from '../../shared/apiTypes';
import { stubRegistry } from '../../test/main/fakeRegistry';
import { tempDir, writeTree } from '../../test/main/fixtures';

/**
 * An iOS project pulls packages in through Swift Package Manager (declared in Package.swift or in
 * the Xcode project itself) and through CocoaPods. The latest version of a Swift package is whatever
 * its git repository has tagged, so that is what is asked for, over plain HTTP.
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

const { swiftAdapter } = await import('./swiftAdapter');

/** A smart-HTTP ref advertisement, in the pkt-line format git servers answer with. */
function refs(tags: string[]): string {
  const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
  const sha = 'a'.repeat(40);
  return [
    line('# service=git-upload-pack\n'),
    '0000',
    line(`${sha} HEAD\0multi_ack\n`),
    line(`${sha} refs/heads/main\n`),
    ...tags.flatMap((tag) => [
      line(`${sha} refs/tags/${tag}\n`),
      line(`${sha} refs/tags/${tag}^{}\n`),
    ]),
    '0000',
  ].join('');
}

const refsUrl = (repo: string) => `${repo}/info/refs?service=git-upload-pack`;

function podShard(name: string): string {
  const hash = createHash('md5').update(name).digest('hex');
  return `https://cdn.cocoapods.org/all_pods_versions_${hash[0]}_${hash[1]}_${hash[2]}.txt`;
}

let root = '';

beforeEach(() => {
  root = tempDir('runova-swift-adapter-');
  cliState.calls = [];
  cliState.handler = () => ({});
  stubRegistry({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<PackageUpdateRequest> = {}): PackageUpdateRequest {
  return {
    ecosystem: 'swift',
    name: 'Alamofire',
    targetVersion: '5.10.0',
    manifestPath: join(root, 'Package.swift'),
    ...overrides,
  };
}

const PACKAGE_SWIFT = `// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "Demo",
    dependencies: [
        .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.8.0"),
        // .package(url: "https://github.com/old/Gone.git", from: "1.0.0"),
        .package(url: "https://github.com/onevcat/Kingfisher", .upToNextMajor(from: "7.0.0")),
        .package(name: "Yams", url: "https://github.com/jpsim/Yams.git", exact: "5.0.0"),
        .package(url: "https://github.com/apple/swift-log.git", "1.0.0"..<"2.0.0"),
        .package(url: "https://github.com/apple/swift-nio.git", branch: "main"),
        .package(path: "../Local"),
    ]
)
`;

const PBXPROJ = `// !$*UTF8*$!
{
/* Begin XCRemoteSwiftPackageReference section */
		AA /* XCRemoteSwiftPackageReference "Alamofire" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/Alamofire/Alamofire.git";
			requirement = {
				kind = upToNextMajorVersion;
				minimumVersion = 5.8.0;
			};
		};
		BB /* XCRemoteSwiftPackageReference "Yams" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/jpsim/Yams";
			requirement = {
				kind = exactVersion;
				version = "5.0.0";
			};
		};
		CC /* XCRemoteSwiftPackageReference "Nio" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/apple/swift-nio.git";
			requirement = {
				branch = main;
				kind = branch;
			};
		};
/* End XCRemoteSwiftPackageReference section */
}
`;

describe('detect', () => {
  it.each(['Package.swift', 'ios/Podfile', 'ios/Demo.xcodeproj/project.pbxproj'])(
    'finds %s',
    async (file) => {
      writeTree(root, { [file]: '' });
      await expect(swiftAdapter.detect(root)).resolves.toBe(true);
    },
  );

  it.each(['Pods', '.build', 'node_modules', 'DerivedData'])(
    'ignores what sits under %s',
    async (dir) => {
      writeTree(root, { [`${dir}/Package.swift`]: '' });
      await expect(swiftAdapter.detect(root)).resolves.toBe(false);
    },
  );
});

describe('Swift packages', () => {
  it('reads Package.swift and skips branch, path and commented entries', async () => {
    writeTree(root, { 'Package.swift': PACKAGE_SWIFT });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section).toMatchObject({ ecosystem: 'swift', manager: 'spm', status: 'ok' });
    expect(section.packages.map((p) => [p.name, p.currentVersion])).toEqual([
      ['Alamofire', '5.8.0'],
      ['Kingfisher', '7.0.0'],
      ['swift-log', '1.0.0'],
      ['Yams', '5.0.0'],
    ]);
  });

  it('takes the resolved version from Package.resolved', async () => {
    writeTree(root, {
      'Package.swift': PACKAGE_SWIFT,
      'Package.resolved': JSON.stringify({
        version: 2,
        pins: [
          {
            identity: 'alamofire',
            location: 'https://github.com/Alamofire/Alamofire.git',
            state: { revision: 'abc', version: '5.9.1' },
          },
        ],
      }),
    });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ currentVersion: '5.9.1', isInstalled: true });
    expect(section.packages[1].isInstalled).toBe(false);
  });

  it('reads the older Package.resolved layout too', async () => {
    writeTree(root, {
      'Package.swift': PACKAGE_SWIFT,
      'Package.resolved': JSON.stringify({
        object: {
          pins: [
            {
              package: 'Alamofire',
              repositoryURL: 'https://github.com/Alamofire/Alamofire.git',
              state: { version: '5.8.5' },
            },
          ],
        },
      }),
    });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.packages[0].currentVersion).toBe('5.8.5');
  });

  it('reads the packages added to an Xcode project and its resolved file', async () => {
    writeTree(root, {
      'ios/Demo.xcodeproj/project.pbxproj': PBXPROJ,
      'ios/Demo.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved':
        JSON.stringify({
          pins: [{ identity: 'yams', state: { version: '5.0.0' } }],
        }),
    });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.packages.map((p) => [p.name, p.currentVersion, p.projectLabel])).toEqual([
      ['Alamofire', '5.8.0', 'Demo'],
      ['Yams', '5.0.0', 'Demo'],
    ]);
  });

  it('finds the newest semver tag of the repository', async () => {
    writeTree(root, { 'Package.swift': PACKAGE_SWIFT });
    stubRegistry({
      [refsUrl('https://github.com/Alamofire/Alamofire.git')]: refs([
        '5.8.0',
        '5.10.0',
        '5.9.0',
        '6.0.0-beta.1',
        'not-a-version',
      ]),
      [refsUrl('https://github.com/onevcat/Kingfisher')]: refs(['v7.0.0', 'v8.1.0']),
    });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ latestVersion: '5.10.0', isOutdated: true });
    // A v prefix on the tag is not part of the version SwiftPM takes.
    expect(section.packages[1]).toMatchObject({ latestVersion: '8.1.0', isOutdated: true });
  });

  it('will not move a range', async () => {
    writeTree(root, { 'Package.swift': PACKAGE_SWIFT });
    stubRegistry({ [refsUrl('https://github.com/apple/swift-log.git')]: refs(['1.0.0', '2.0.0']) });

    const [section] = await swiftAdapter.listPackages(root);
    const log = section.packages.find((p) => p.name === 'swift-log');

    expect(log?.isOutdated).toBe(false);
  });

  it('asks over https only, whatever the manifest says', async () => {
    writeTree(root, {
      'Package.swift': `let package = Package(dependencies: [
  .package(url: "git@github.com:acme/Private.git", from: "1.0.0"),
  .package(url: "ext::sh -c touch%20/tmp/pwn", from: "1.0.0"),
  .package(url: "http://internal.example/Plain.git", from: "1.0.0"),
])`,
    });
    const requests = stubRegistry({});

    await swiftAdapter.listPackages(root);

    expect(requests).toEqual([refsUrl('https://github.com/acme/Private.git')]);
  });

  it('counts a repository it could not read as unknown, not current', async () => {
    writeTree(root, { 'Package.swift': PACKAGE_SWIFT });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.packages[0].latestVersion).toBeNull();
    expect(section.message).toContain('could not be looked up');
  });

  it('trusts a manifest that has moved past a stale Package.resolved', async () => {
    writeTree(root, {
      'Package.swift':
        'let package = Package(dependencies: [.package(url: "https://github.com/a/B.git", from: "2.0.0")])',
      'Package.resolved': JSON.stringify({
        pins: [{ identity: 'b', state: { version: '1.0.0' } }],
      }),
    });
    stubRegistry({ [refsUrl('https://github.com/a/B.git')]: refs(['2.0.0']) });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ currentVersion: '2.0.0', isOutdated: false });
  });

  it('adds no section when Package.swift has no dependencies', async () => {
    writeTree(root, { 'Package.swift': 'let package = Package(name: "Demo")\n' });

    await expect(swiftAdapter.listPackages(root)).resolves.toEqual([]);
  });
});

describe('updating Swift packages', () => {
  it('rewrites just the version in Package.swift, whichever form it is in', async () => {
    writeTree(root, { 'Package.swift': PACKAGE_SWIFT });

    const result = await swiftAdapter.updatePackages(
      root,
      [
        request(),
        request({ name: 'Kingfisher', targetVersion: '8.1.0' }),
        request({ name: 'yams', targetVersion: '6.0.0' }),
      ],
      () => undefined,
    );

    expect(result.ok).toBe(true);
    const updated = readFileSync(join(root, 'Package.swift'), 'utf-8');
    expect(updated).toContain('Alamofire.git", from: "5.10.0")');
    expect(updated).toContain('.upToNextMajor(from: "8.1.0")');
    expect(updated).toContain('exact: "6.0.0")');
    expect(updated).toContain('branch: "main"');
    expect(cliState.calls).toEqual([]);
  });

  it('rewrites the requirement block in an Xcode project', async () => {
    const manifestPath = join(root, 'ios', 'Demo.xcodeproj', 'project.pbxproj');
    writeTree(root, { 'ios/Demo.xcodeproj/project.pbxproj': PBXPROJ });

    await swiftAdapter.updatePackages(
      root,
      [request({ manifestPath }), request({ name: 'Yams', targetVersion: '6.0.0', manifestPath })],
      () => undefined,
    );

    const updated = readFileSync(manifestPath, 'utf-8');
    expect(updated).toContain('minimumVersion = 5.10.0;');
    expect(updated).toContain('version = "6.0.0";');
    expect(updated).toContain('branch = main;');
  });

  it('reports a package the manifest no longer has', async () => {
    writeTree(root, { 'Package.swift': 'let package = Package(name: "D")\n' });

    const result = await swiftAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toContain('Alamofire');
  });
});

describe('CocoaPods', () => {
  const PODFILE = `platform :ios, '15.0'
target 'Demo' do
  pod 'Alamofire', '~> 5.6'
  pod "SDWebImage", "5.18.0"
  pod 'Firebase/Analytics', '~> 10.0.0'
  # pod 'Gone', '1.0'
  pod 'Local', :path => '../Local'
  pod 'Forked', :git => 'https://example.com/forked.git'
  pod 'Loose'
end
`;
  const LOCK = `PODS:
  - Alamofire (5.6.4)
  - Firebase/Analytics (10.0.0):
    - FirebaseCore (~> 10.0)
  - FirebaseCore (10.0.1)
  - Loose (1.0.0)
  - SDWebImage (5.18.0)

DEPENDENCIES:
  - Alamofire (~> 5.6)
`;

  it('reads the Podfile and the locked versions, skipping local and git pods', async () => {
    writeTree(root, { 'ios/Podfile': PODFILE, 'ios/Podfile.lock': LOCK });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section).toMatchObject({ ecosystem: 'swift', manager: 'cocoapods' });
    expect(section.packages.map((p) => [p.name, p.currentVersion])).toEqual([
      ['Alamofire', '5.6.4'],
      ['Firebase/Analytics', '10.0.0'],
      ['Loose', '1.0.0'],
      ['SDWebImage', '5.18.0'],
    ]);
    expect(section.packages[0].projectLabel).toBe('ios');
  });

  it('looks a pod up in the CDN shard for its root name', async () => {
    writeTree(root, { 'ios/Podfile': PODFILE, 'ios/Podfile.lock': LOCK });
    stubRegistry({
      [podShard('Alamofire')]: 'Alamofire/5.6.4/5.9.1/6.0.0-beta.1\nAlamoOther/1.0.0\n',
      [podShard('Firebase')]: 'Firebase/10.0.0/10.5.0\n',
    });

    const [section] = await swiftAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({ latestVersion: '5.9.1', isOutdated: true });
    expect(section.packages[1]).toMatchObject({ latestVersion: '10.5.0', isOutdated: true });
  });

  it('adds no section for a Podfile with no pods of its own, as in a Flutter app', async () => {
    writeTree(root, {
      'ios/Podfile':
        "target 'Runner' do\n  flutter_install_all_ios_pods File.dirname(__FILE__)\nend\n",
    });

    await expect(swiftAdapter.listPackages(root)).resolves.toEqual([]);
  });

  it('rewrites the Podfile in the same style, then runs pod update', async () => {
    const manifestPath = join(root, 'ios', 'Podfile');
    writeTree(root, { 'ios/Podfile': PODFILE, 'ios/Podfile.lock': LOCK });

    const result = await swiftAdapter.updatePackages(
      root,
      [
        request({ targetVersion: '5.9.1', manifestPath }),
        request({ name: 'SDWebImage', targetVersion: '5.19.0', manifestPath }),
        request({ name: 'Firebase/Analytics', targetVersion: '10.5.0', manifestPath }),
      ],
      () => undefined,
    );

    expect(result.ok).toBe(true);
    const updated = readFileSync(manifestPath, 'utf-8');
    expect(updated).toContain("pod 'Alamofire', '~> 5.9'");
    expect(updated).toContain('pod "SDWebImage", "5.19.0"');
    expect(updated).toContain("pod 'Firebase/Analytics', '~> 10.5.0'");
    expect(cliState.calls).toEqual([
      {
        command: 'pod',
        args: ['update', 'Alamofire', 'SDWebImage', 'Firebase'],
        cwd: join(root, 'ios'),
      },
    ]);
  });

  it('keeps a changed Podfile and says so where pod cannot run', async () => {
    const manifestPath = join(root, 'ios', 'Podfile');
    writeTree(root, { 'ios/Podfile': PODFILE, 'ios/Podfile.lock': LOCK });
    cliState.handler = () => ({ notFound: true });

    const result = await swiftAdapter.updatePackages(
      root,
      [request({ targetVersion: '5.9.1', manifestPath })],
      () => undefined,
    );

    // The Podfile is the change; pod install on the Mac that builds the app finishes it.
    expect(result.ok).toBe(true);
    expect(result.results[0].message).toContain('pod install');
    expect(readFileSync(manifestPath, 'utf-8')).toContain("'~> 5.9'");
  });

  it('fails when only the lock could have moved and pod is missing', async () => {
    const manifestPath = join(root, 'ios', 'Podfile');
    writeTree(root, { 'ios/Podfile': PODFILE, 'ios/Podfile.lock': LOCK });
    cliState.handler = () => ({ notFound: true });

    const result = await swiftAdapter.updatePackages(
      root,
      [request({ name: 'Loose', targetVersion: '2.0.0', manifestPath })],
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toBe(
      'Install CocoaPods and add it to PATH to update these pods.',
    );
  });

  it('gives one section each when a project uses both', async () => {
    writeTree(root, { 'Package.swift': PACKAGE_SWIFT, 'ios/Podfile': PODFILE });

    const sections = await swiftAdapter.listPackages(root);

    expect(sections.map((s) => s.manager)).toEqual(['spm', 'cocoapods']);
  });
});
