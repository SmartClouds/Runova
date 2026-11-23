import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageUpdateRequest } from '../../shared/apiTypes';
import { tempDir, writeTree } from '../../test/main/fixtures';
import type { UpdateProgressTick } from './types';

/**
 * Listing never runs `dotnet`: the .csproj is the source of truth for which packages exist, and
 * obj/project.assets.json (what the last restore resolved) only enriches it. The cases worth
 * pinning are the ones where those two disagree, and that no listing ever starts the CLI.
 */

interface CliCall {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

interface CliAnswer {
  stdout?: string;
  stderr?: string;
  code?: number;
  notFound?: boolean;
}

const cliState = vi.hoisted(() => ({
  calls: [] as CliCall[],
  handler: (_command: string, _args: string[]): CliAnswer => ({}),
}));

// execUtils is this module's own process boundary; its own tests cover the cmd.exe quoting.
vi.mock('./execUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./execUtils')>();
  return {
    ...actual,
    runCli: async (command: string, args: string[], cwd: string, timeoutMs?: number) => {
      cliState.calls.push({ command, args, cwd, timeoutMs });
      const answer = cliState.handler(command, args);
      if (answer.notFound) throw new actual.CliNotFoundError(`${command} is not available on PATH`);
      return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', code: answer.code ?? 0 };
    },
  };
});

const feedState = vi.hoisted(() => ({
  versions: {} as Record<string, unknown>,
}));

// The runtime feeds are public JSON files; no test may reach them. Each test sets what they say.
vi.mock('./runtimeFeeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtimeFeeds')>();
  const answer = async (key: string) => feedState.versions[key] ?? null;
  return {
    ...actual,
    runtimeFeeds: {
      nodeLts: () => answer('node'),
      npmPackage: (name: string) => answer(`npm:${name}`),
      dotnet: () => answer('dotnet'),
      dart: () => answer('dart'),
      flutter: () => answer('flutter'),
    },
  };
});

const { dotnetAdapter } = await import('./dotnetAdapter');

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Include="Serilog">
      <Version>3.1.1</Version>
    </PackageReference>
  </ItemGroup>
</Project>
`;

/** A trimmed obj/project.assets.json, as `dotnet restore` writes it for one net8.0 project. */
function assetsJson(
  projectPath: string,
  packages: { id: string; version: string; autoReferenced?: boolean }[],
): string {
  return JSON.stringify({
    version: 4,
    targets: {
      'net8.0': Object.fromEntries(
        packages.map((p) => [`${p.id}/${p.version}`, { type: 'package' }]),
      ),
    },
    project: {
      restore: { projectPath },
      frameworks: {
        'net8.0': {
          dependencies: Object.fromEntries(
            packages.map((p) => [
              p.id,
              {
                target: 'Package',
                version: `[${p.version}, )`,
                ...(p.autoReferenced ? { autoReferenced: true } : {}),
              },
            ]),
          ),
        },
      },
    },
  });
}

let root = '';

beforeEach(() => {
  feedState.versions = {};
  cliState.calls = [];
  cliState.handler = () => ({});
  root = tempDir('runova-dotnet-adapter-');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers nuget.org, so no test can reach the real feed. */
function stubNuget(versions: Record<string, string[]>): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const name = /v3-flatcontainer\/([^/]+)\/index\.json/.exec(String(url))?.[1] ?? '';
    requested.push(name);
    const list = versions[name];
    if (!list) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ versions: list }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return requested;
}

describe('detect', () => {
  it.each(['App.csproj', 'Lib.vbproj', 'Core.fsproj', 'Mixed.CSPROJ'])(
    'is true for %s',
    async (file) => {
      writeTree(root, { [file]: CSPROJ });
      await expect(dotnetAdapter.detect(root)).resolves.toBe(true);
    },
  );

  it('finds a project nested a few folders down', async () => {
    writeTree(root, { 'src/App/App.csproj': CSPROJ });
    await expect(dotnetAdapter.detect(root)).resolves.toBe(true);
  });

  it('is false for a folder with no project file', async () => {
    writeTree(root, { 'App.sln': 'Microsoft Visual Studio Solution File\n' });
    await expect(dotnetAdapter.detect(root)).resolves.toBe(false);
  });

  it.each(['bin', 'obj', 'packages', 'TestResults', 'node_modules', '.git'])(
    'ignores build output under %s',
    async (dir) => {
      writeTree(root, { [`${dir}/App.csproj`]: CSPROJ });
      // obj holds generated copies of the project file that would otherwise be scanned twice.
      await expect(dotnetAdapter.detect(root)).resolves.toBe(false);
    },
  );

  it('stops descending past the depth cap', async () => {
    writeTree(root, { 'a/b/c/d/e/f/App.csproj': CSPROJ });
    await expect(dotnetAdapter.detect(root)).resolves.toBe(false);
  });
});

describe('listPackages without the CLI', () => {
  beforeEach(() => {
    writeTree(root, { 'src/App/App.csproj': CSPROJ });
    stubNuget({});
  });

  it('runs no dotnet command, even in a repo whose targets would run code', async () => {
    // `dotnet list package` evaluates the project and runs targets like CollectPackageReferences
    // even with --no-restore, so a cloned repo could run anything just by being listed. The
    // assets file here is committed from another machine, which only ever counts as data.
    writeTree(root, {
      'src/App/Directory.Build.targets': `<Project>
  <Target Name="Payload" BeforeTargets="CollectPackageReferences;Restore">
    <Exec Command="calc.exe" />
  </Target>
</Project>`,
      'src/App/obj/project.assets.json': assetsJson('D:\\elsewhere\\src\\App\\App.csproj', [
        { id: 'Newtonsoft.Json', version: '13.0.1' },
      ]),
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(cliState.calls).toEqual([]);
    expect(section.packages.find((p) => p.name === 'Newtonsoft.Json')).toMatchObject({
      currentVersion: '13.0.1',
      isInstalled: true,
    });
  });

  it('lists packages without the .NET SDK installed', async () => {
    cliState.handler = () => ({ notFound: true });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section).toMatchObject({ status: 'ok', toolchain: 'dotnet-sdk' });
    expect(section.runtimes).toEqual([
      expect.objectContaining({ source: 'target-framework', declared: 'net8.0' }),
    ]);
    expect(section.packages.map((p) => p.name)).toEqual(['Newtonsoft.Json', 'Serilog']);
  });

  it('returns an empty ok section when there is no project to scan', async () => {
    const empty = tempDir('runova-dotnet-empty-');

    const [section] = await dotnetAdapter.listPackages(empty);

    expect(section).toEqual({
      ecosystem: 'dotnet',
      manager: 'nuget',
      status: 'ok',
      message: null,
      packages: [],
      runtimes: [],
      toolchain: 'dotnet-sdk',
    });
    expect(cliState.calls).toEqual([]);
  });
});

describe('manifest parsing', () => {
  beforeEach(() => stubNuget({}));

  it('reads both the Version attribute and the nested Version element', async () => {
    writeTree(root, { 'App.csproj': CSPROJ });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.map((p) => p.name)).toEqual(['Newtonsoft.Json', 'Serilog']);
    expect(section.packages.map((p) => p.currentVersion)).toEqual(['13.0.1', '3.1.1']);
  });

  it('ignores a PackageReference that is commented out', async () => {
    writeTree(root, {
      'App.csproj': `<Project>
  <ItemGroup>
    <PackageReference Include="Live" Version="1.0.0" />
    <!-- <PackageReference Include="Removed" Version="0.9.0" /> -->
  </ItemGroup>
</Project>`,
    });

    const [section] = await dotnetAdapter.listPackages(root);

    // A commented-out reference is not a dependency and must not be offered for update.
    expect(section.packages.map((p) => p.name)).toEqual(['Live']);
  });

  it('reads the Update form used to pin a version coming from a props import', async () => {
    writeTree(root, {
      'App.csproj': `<Project><ItemGroup>
        <PackageReference Update="Microsoft.SourceLink.GitHub" Version="8.0.0" />
      </ItemGroup></Project>`,
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages[0]).toMatchObject({
      name: 'Microsoft.SourceLink.GitHub',
      currentVersion: '8.0.0',
    });
  });

  it('reads legacy packages.config alongside the project file', async () => {
    writeTree(root, {
      'App.csproj': '<Project><ItemGroup></ItemGroup></Project>',
      'packages.config': `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="EntityFramework" version="6.4.4" targetFramework="net48" />
  <package id="NUnit" version="3.13.3" targetFramework="net48" />
</packages>`,
    });

    const [section] = await dotnetAdapter.listPackages(root);

    // Non-SDK-style projects keep their packages here, not in the .csproj.
    expect(section.packages.map((p) => p.name)).toEqual(['EntityFramework', 'NUnit']);
    expect(section.packages[0].currentVersion).toBe('6.4.4');
  });

  it('resolves a Central Package Management version from the nearest props file', async () => {
    writeTree(root, {
      'Directory.Packages.props': `<Project>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>`,
      'src/App/App.csproj': `<Project><ItemGroup>
        <PackageReference Include="Newtonsoft.Json" />
      </ItemGroup></Project>`,
    });

    const [section] = await dotnetAdapter.listPackages(root);

    // Under CPM the .csproj carries no version, so the walk up the tree is the only source.
    expect(section.packages[0]).toMatchObject({
      name: 'Newtonsoft.Json',
      currentVersion: '13.0.3',
    });
  });

  it('prefers the props file closest to the project', async () => {
    writeTree(root, {
      'Directory.Packages.props':
        '<Project><ItemGroup><PackageVersion Include="Serilog" Version="1.0.0" /></ItemGroup></Project>',
      'src/Directory.Packages.props':
        '<Project><ItemGroup><PackageVersion Include="Serilog" Version="4.0.0" /></ItemGroup></Project>',
      'src/App.csproj':
        '<Project><ItemGroup><PackageReference Include="Serilog" /></ItemGroup></Project>',
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages[0].currentVersion).toBe('4.0.0');
  });

  it('falls back to unknown when no version can be found anywhere', async () => {
    writeTree(root, {
      'App.csproj':
        '<Project><ItemGroup><PackageReference Include="Mystery" /></ItemGroup></Project>',
    });
    stubNuget({ mystery: ['1.0.0'] });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages[0].currentVersion).toBe('unknown');
    // An unknown current version can never be compared, so it is never flagged outdated.
    expect(section.packages[0].isOutdated).toBe(false);
  });
});

describe('merging the restore output with the manifest', () => {
  const project = (): string => join(root, 'App.csproj');

  function restore(packages: { id: string; version: string; autoReferenced?: boolean }[]): void {
    writeTree(root, { 'obj/project.assets.json': assetsJson(project(), packages) });
  }

  beforeEach(() => {
    writeTree(root, { 'App.csproj': CSPROJ });
  });

  it('marks a package outdated when nuget.org has a newer stable version', async () => {
    stubNuget({ 'newtonsoft.json': ['13.0.1', '13.0.3'], serilog: ['3.1.1'] });
    restore([
      { id: 'Newtonsoft.Json', version: '13.0.1' },
      { id: 'Serilog', version: '3.1.1' },
    ]);

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'Newtonsoft.Json')).toMatchObject({
      currentVersion: '13.0.1',
      latestVersion: '13.0.3',
      isOutdated: true,
      isInstalled: true,
      projectLabel: 'App',
      manifestPath: project(),
    });
    expect(section.packages.find((p) => p.name === 'Serilog')).toMatchObject({
      latestVersion: '3.1.1',
      isOutdated: false,
    });
  });

  it('shows the version the restore resolved over the one the project file asks for', async () => {
    stubNuget({});
    restore([
      { id: 'Newtonsoft.Json', version: '13.0.3' },
      { id: 'Serilog', version: '3.1.1' },
    ]);

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'Newtonsoft.Json')?.currentVersion).toBe(
      '13.0.3',
    );
  });

  it('includes a package the restore found but the manifest does not declare', async () => {
    stubNuget({});
    restore([
      { id: 'Newtonsoft.Json', version: '13.0.1' },
      { id: 'Serilog', version: '3.1.1' },
      { id: 'Microsoft.Extensions.Logging', version: '8.0.0' },
    ]);

    const [section] = await dotnetAdapter.listPackages(root);

    // A package can come in through an imported .props file the parser never sees.
    expect(section.packages.find((p) => p.name === 'Microsoft.Extensions.Logging')).toMatchObject({
      currentVersion: '8.0.0',
      isInstalled: true,
    });
  });

  it('leaves out packages the SDK references by itself', async () => {
    stubNuget({});
    restore([
      { id: 'Newtonsoft.Json', version: '13.0.1' },
      { id: 'Serilog', version: '3.1.1' },
      { id: 'NETStandard.Library', version: '2.0.3', autoReferenced: true },
    ]);

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.map((p) => p.name)).toEqual(['Newtonsoft.Json', 'Serilog']);
  });

  it('matches a package across the two files whatever its case', async () => {
    stubNuget({});
    restore([
      { id: 'newtonsoft.json', version: '13.0.2' },
      { id: 'Serilog', version: '3.1.1' },
    ]);

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.map((p) => p.name)).toEqual(['Newtonsoft.Json', 'Serilog']);
    expect(section.packages[0].currentVersion).toBe('13.0.2');
  });

  it('ignores an assets file restored for another project in the same folder', async () => {
    stubNuget({});
    writeTree(root, {
      'obj/project.assets.json': assetsJson(join(root, 'Other.csproj'), [
        { id: 'Newtonsoft.Json', version: '9.0.1' },
      ]),
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'Newtonsoft.Json')).toMatchObject({
      currentVersion: '13.0.1',
      isInstalled: false,
    });
  });

  it('sorts packages by name so the list does not reshuffle between scans', async () => {
    stubNuget({});
    restore([
      { id: 'Serilog', version: '3.1.1' },
      { id: 'AWSSDK.Core', version: '3.7.0' },
      { id: 'Newtonsoft.Json', version: '13.0.1' },
    ]);

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.map((p) => p.name)).toEqual([
      'AWSSDK.Core',
      'Newtonsoft.Json',
      'Serilog',
    ]);
  });

  it('does not call a prerelease newer than the latest stable outdated', async () => {
    stubNuget({ serilog: ['3.1.1', '4.0.0', '4.1.0-dev.1'] });
    restore([
      { id: 'Newtonsoft.Json', version: '13.0.1' },
      { id: 'Serilog', version: '4.1.0-dev.1' },
    ]);

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.packages.find((p) => p.name === 'Serilog')).toMatchObject({
      currentVersion: '4.1.0-dev.1',
      isOutdated: false,
    });
  });

  it('picks the newest stable version from the nuget index, not a prerelease', async () => {
    stubNuget({ 'newtonsoft.json': ['12.0.3', '13.0.3', '14.0.0-beta1'] });

    const [section] = await dotnetAdapter.listPackages(root);

    // The flat container index is sorted ascending, so the last stable entry is the latest.
    expect(section.packages.find((p) => p.name === 'Newtonsoft.Json')?.latestVersion).toBe(
      '13.0.3',
    );
  });

  it('leaves a package alone when nuget.org has never heard of it', async () => {
    stubNuget({});

    const [section] = await dotnetAdapter.listPackages(root);

    // A 404 means a private feed package, which is not an error worth showing.
    expect(section.packages.every((p) => p.isOutdated === false)).toBe(true);
  });
});

describe('degraded projects', () => {
  it('warns that versions came from the project file when it was never restored', async () => {
    writeTree(root, { 'src/App/App.csproj': CSPROJ });
    stubNuget({});

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.status).toBe('ok');
    expect(section.message).toContain('App has not been restored yet');
    expect(section.message).toContain('may not reflect what is resolved at build time');
    // The packages still come through, just from the manifest alone.
    expect(section.packages.map((p) => p.name)).toEqual(['Newtonsoft.Json', 'Serilog']);
    expect(section.packages.every((p) => p.isInstalled === false)).toBe(true);
  });

  it('names every project that was not restored', async () => {
    writeTree(root, { 'a/A.csproj': CSPROJ, 'b/B.csproj': CSPROJ });
    stubNuget({});

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.message).toContain('A, B have not been restored yet');
  });

  it('says nothing when every project restored', async () => {
    writeTree(root, {
      'App.csproj': CSPROJ,
      'obj/project.assets.json': assetsJson(join(root, 'App.csproj'), [
        { id: 'Newtonsoft.Json', version: '13.0.1' },
        { id: 'Serilog', version: '3.1.1' },
      ]),
    });
    stubNuget({});

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.message).toBeNull();
  });

  it('does not call a project with no packages at all degraded', async () => {
    writeTree(root, { 'Empty.csproj': '<Project><ItemGroup /></Project>' });
    stubNuget({});

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.message).toBeNull();
    expect(section.packages).toEqual([]);
  });
});

describe('updatePackages', () => {
  function request(overrides: Partial<PackageUpdateRequest> = {}): PackageUpdateRequest {
    return {
      ecosystem: 'dotnet',
      name: 'Newtonsoft.Json',
      targetVersion: '13.0.3',
      manifestPath: join(root, 'src', 'App', 'App.csproj'),
      ...overrides,
    };
  }

  it('runs dotnet add package with an explicit version, from the project folder', async () => {
    await dotnetAdapter.updatePackages(root, [request()], () => undefined);

    expect(cliState.calls).toEqual([
      {
        command: 'dotnet',
        args: [
          'add',
          join(root, 'src', 'App', 'App.csproj'),
          'package',
          'Newtonsoft.Json',
          '--version',
          '13.0.3',
        ],
        cwd: join(root, 'src', 'App'),
        timeoutMs: 2 * 60 * 1000,
      },
    ]);
  });

  it('runs one package at a time so parallel restores cannot race on the nuget cache', async () => {
    let concurrent = 0;
    let peak = 0;
    cliState.handler = () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      concurrent--;
      return {};
    };

    await dotnetAdapter.updatePackages(
      root,
      [request(), request({ name: 'Serilog', targetVersion: '4.0.0' })],
      () => undefined,
    );

    expect(peak).toBe(1);
    expect(cliState.calls).toHaveLength(2);
  });

  it('reports progress around each package', async () => {
    const ticks: UpdateProgressTick[] = [];

    const result = await dotnetAdapter.updatePackages(
      root,
      [request(), request({ name: 'Serilog' })],
      (tick) => ticks.push(tick),
    );

    expect(result).toEqual({
      ok: true,
      results: [
        { name: 'Newtonsoft.Json', ok: true, message: 'Updated' },
        { name: 'Serilog', ok: true, message: 'Updated' },
      ],
    });
    expect(ticks).toEqual([
      { packageName: 'Newtonsoft.Json', status: 'running', completed: 0, total: 2 },
      {
        packageName: 'Newtonsoft.Json',
        status: 'done',
        message: undefined,
        completed: 1,
        total: 2,
      },
      { packageName: 'Serilog', status: 'running', completed: 1, total: 2 },
      { packageName: 'Serilog', status: 'done', message: undefined, completed: 2, total: 2 },
    ]);
  });

  it('surfaces the tail of the CLI output when an update fails', async () => {
    cliState.handler = () => ({
      code: 1,
      stderr: 'error NU1102: Unable to find package Newtonsoft.Json with version (>= 99.0.0)',
    });

    const result = await dotnetAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.ok).toBe(false);
    expect(result.results[0].message).toContain('NU1102');
  });

  it('falls back to a generic message when the failing CLI printed nothing', async () => {
    cliState.handler = () => ({ code: 3 });

    const result = await dotnetAdapter.updatePackages(root, [request()], () => undefined);

    expect(result.results[0].message).toBe('dotnet exited with code 3');
  });

  it('keeps going after one package fails', async () => {
    let call = 0;
    cliState.handler = () => {
      call++;
      return call === 1 ? { code: 1, stderr: 'nope' } : {};
    };

    const result = await dotnetAdapter.updatePackages(
      root,
      [request(), request({ name: 'Serilog' })],
      () => undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.results.map((r) => r.ok)).toEqual([false, true]);
  });

  it('handles an empty batch', async () => {
    await expect(dotnetAdapter.updatePackages(root, [], () => undefined)).resolves.toEqual({
      ok: true,
      results: [],
    });
  });
});

describe('runtime targets', () => {
  const sdk = (version: string | null) => ({ installedVersion: async () => version });
  const project = (tfm: string) =>
    `<Project Sdk="Microsoft.NET.Sdk">\r\n  <PropertyGroup>\r\n    ${tfm}\r\n  </PropertyGroup>\r\n</Project>\r\n`;

  beforeEach(() => {
    feedState.versions = { dotnet: { channel: '10.0', latestSdk: '10.0.100' } };
  });

  it('lists each project target framework and the global.json SDK pin', async () => {
    writeTree(root, {
      'global.json': '{ "sdk": { "version": "8.0.404" } }',
      'src/Api/Api.csproj': project('<TargetFramework>net8.0</TargetFramework>'),
      'src/App/App.csproj': project('<TargetFramework>net9.0-android</TargetFramework>'),
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.toolchain).toBe('dotnet-sdk');
    const bySource = (source: string) => section.runtimes.filter((t) => t.source === source);
    expect(bySource('target-framework')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectLabel: 'Api',
          declared: 'net8.0',
          nextDeclared: 'net10.0',
          requires: { toolchain: 'dotnet-sdk', minVersion: '10.0.100' },
        }),
        expect.objectContaining({ projectLabel: 'App', nextDeclared: 'net10.0-android' }),
      ]),
    );
    // One global.json for the whole repo, so one row, not one per project.
    expect(bySource('global-json')).toEqual([
      expect.objectContaining({
        declared: '8.0.404',
        latestVersion: '10.0.100',
        nextDeclared: '10.0.100',
        projectLabel: 'global.json',
      }),
    ]);
  });

  it('shows a target framework inherited from Directory.Build.props once', async () => {
    writeTree(root, {
      'Directory.Build.props': project('<TargetFramework>net8.0</TargetFramework>'),
      'src/A/A.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
      'src/B/B.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.runtimes).toEqual([
      expect.objectContaining({
        source: 'target-framework',
        manifestPath: join(root, 'Directory.Build.props'),
        projectLabel: 'Directory.Build.props',
      }),
    ]);
  });

  it('reports a multi-target list but leaves it to the AI prompt', async () => {
    writeTree(root, {
      'Lib/Lib.csproj': project('<TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks>'),
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.runtimes).toEqual([
      expect.objectContaining({ currentVersion: '8.0', isOutdated: true, nextDeclared: null }),
    ]);
  });

  it('leaves .NET Framework projects out', async () => {
    writeTree(root, {
      'Legacy/Legacy.csproj': project('<TargetFramework>net48</TargetFramework>'),
    });

    const [section] = await dotnetAdapter.listPackages(root);

    expect(section.runtimes).toEqual([]);
  });

  it('rewrites the target framework when an SDK that can build it is installed', async () => {
    const xml = project('<TargetFramework>net8.0</TargetFramework>');
    writeTree(root, { 'Api/Api.csproj': xml });
    const manifestPath = join(root, 'Api', 'Api.csproj');

    const result = await dotnetAdapter.updateRuntime(
      root,
      {
        ecosystem: 'dotnet',
        source: 'target-framework',
        kind: 'dotnet',
        manifestPath,
        targetVersion: '10.0',
      },
      sdk('10.0.100'),
    );

    expect(result).toEqual({ ok: true, message: 'Updated net8.0 to net10.0.' });
    expect(readFileSync(manifestPath, 'utf-8')).toBe(xml.replace('net8.0', 'net10.0'));
  });

  it('refuses the target framework while only an older SDK is installed', async () => {
    writeTree(root, { 'Api/Api.csproj': project('<TargetFramework>net8.0</TargetFramework>') });
    const manifestPath = join(root, 'Api', 'Api.csproj');

    const result = await dotnetAdapter.updateRuntime(
      root,
      {
        ecosystem: 'dotnet',
        source: 'target-framework',
        kind: 'dotnet',
        manifestPath,
        targetVersion: '10.0',
      },
      sdk('8.0.404'),
    );

    expect(result).toEqual({
      ok: false,
      message:
        'This needs the .NET SDK 10.0.100 or newer, and 8.0.404 is installed. Upgrade the .NET SDK first.',
    });
    expect(readFileSync(manifestPath, 'utf-8')).toContain('net8.0');
  });

  it('moves the global.json pin to the newest SDK', async () => {
    writeTree(root, {
      'global.json': '{\n  "sdk": {\n    "version": "8.0.404"\n  }\n}\n',
      'Api/Api.csproj': project('<TargetFramework>net10.0</TargetFramework>'),
    });
    const manifestPath = join(root, 'global.json');

    const result = await dotnetAdapter.updateRuntime(
      root,
      {
        ecosystem: 'dotnet',
        source: 'global-json',
        kind: 'dotnet',
        manifestPath,
        targetVersion: '10.0.100',
      },
      sdk('10.0.100'),
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(manifestPath, 'utf-8')).toBe(
      '{\n  "sdk": {\n    "version": "10.0.100"\n  }\n}\n',
    );
  });
});

describe('readInventory', () => {
  it('lists each PackageReference with its version, central ones included, and runs no CLI', async () => {
    writeTree(root, {
      'Directory.Packages.props':
        '<Project><ItemGroup><PackageVersion Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
      'src/Api/Api.csproj': `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Serilog" />
    <PackageReference Include="Dapper" Version="[2.1.35]" />
    <!-- <PackageReference Include="Commented.Out" Version="1.0.0" /> -->
  </ItemGroup>
</Project>`,
      'tests/Api.Tests/Api.Tests.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup><PackageReference Include="xunit"><Version>2.9.0</Version></PackageReference><PackageReference Include="dapper" Version="2.1.35" /></ItemGroup>
</Project>`,
    });

    const inventory = await dotnetAdapter.readInventory(root);

    expect(inventory).toEqual([
      { ecosystem: 'nuget', name: 'Dapper', version: '2.1.35', dev: false },
      { ecosystem: 'nuget', name: 'Serilog', version: '3.1.1', dev: false },
      { ecosystem: 'nuget', name: 'xunit', version: '2.9.0', dev: false },
    ]);
    expect(cliState.calls).toEqual([]);
  });

  it('skips a package whose version can not be told', async () => {
    writeTree(root, {
      'App.csproj':
        '<Project><ItemGroup><PackageReference Include="Floating" Version="*" /><PackageReference Include="NoVersion" /></ItemGroup></Project>',
    });

    expect(await dotnetAdapter.readInventory(root)).toEqual([]);
  });
});
