import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageInfo, PackageManagerSection } from '../../../shared/apiTypes';
import type { AiTool, ToolContext } from '../registry';

const ROOT = join('C:', 'code', 'shop');
const WEB = join(ROOT, 'web', 'package.json');
const API = join(ROOT, 'api', 'package.json');

const state = vi.hoisted(() => ({
  scan: vi.fn(),
  nodeUpdate: vi.fn(),
}));

vi.mock('../../worktrees/resolve', () => ({
  findProjectScope: async (id: string) => (id === 'p1' ? { id, folderPath: ROOT } : null),
}));

vi.mock('../../packageManagers', () => ({
  scanProjectPackages: state.scan,
  PACKAGE_MANAGER_ADAPTERS: [
    { ecosystem: 'node', updatePackages: state.nodeUpdate, updateRuntime: vi.fn() },
  ],
}));

vi.mock('../../devSetup/runtime', () => ({ getDevSetupService: () => ({ detect: vi.fn() }) }));

/** The package tools: what the Packages tab lists, what is out of date, and updating packages. */

function pkg(overrides: Partial<PackageInfo>): PackageInfo {
  return {
    name: 'react',
    currentVersion: '19.0.0',
    latestVersion: '19.0.0',
    isOutdated: false,
    isDev: false,
    isInstalled: true,
    manifestPath: WEB,
    projectLabel: 'web',
    ...overrides,
  };
}

const sections: PackageManagerSection[] = [
  {
    ecosystem: 'node',
    manager: 'pnpm',
    status: 'ok',
    message: null,
    toolchain: 'pnpm',
    packages: [
      pkg({ name: 'react' }),
      pkg({ name: 'vite', currentVersion: '6.0.0', latestVersion: '7.1.0', isOutdated: true }),
      pkg({
        name: 'zod',
        currentVersion: '3.0.0',
        latestVersion: '4.1.0',
        isOutdated: true,
        manifestPath: API,
        projectLabel: 'api',
      }),
      pkg({
        name: 'zod',
        currentVersion: '3.2.0',
        latestVersion: '4.1.0',
        isOutdated: true,
        isDev: true,
      }),
    ],
    runtimes: [
      {
        kind: 'node',
        source: 'engines',
        declared: '>=20',
        currentVersion: '20.0.0',
        latestVersion: '24.0.0',
        isOutdated: true,
        nextDeclared: '>=24',
        requires: null,
        manifestPath: WEB,
        projectLabel: 'web',
      },
    ],
  },
  {
    ecosystem: 'dotnet',
    manager: 'nuget',
    status: 'cli-missing',
    message: 'dotnet is not installed.',
    toolchain: 'dotnet-sdk',
    packages: [],
    runtimes: [],
  },
];

const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let tools: Map<string, AiTool>;

beforeEach(async () => {
  vi.resetModules();
  state.scan.mockReset().mockResolvedValue(sections);
  state.nodeUpdate.mockReset().mockResolvedValue({
    ok: true,
    results: [{ name: 'vite', ok: true, message: 'Updated' }],
  });
  const { packageTools } = await import('./packages');
  tools = new Map(packageTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

async function preview(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.preview(tool.input.parse(args), context);
}

describe('package tools', () => {
  it('lists every package by manager, and says when a manager could not be read', async () => {
    const data = (await run('packages_list')).data as {
      manager: string;
      status: string;
      message: string | null;
      packages: Record<string, unknown>[];
    }[];
    expect(state.scan).toHaveBeenCalledWith(ROOT);
    expect(data[0].manager).toBe('pnpm');
    expect(data[0].packages).toHaveLength(4);
    expect(data[0].packages[1]).toMatchObject({
      name: 'vite',
      current: '6.0.0',
      latest: '7.1.0',
      outdated: true,
      project: 'web',
    });
    expect(data[1]).toMatchObject({ manager: 'nuget', status: 'cli-missing' });
  });

  it('gives only what is out of date, with the runtimes', async () => {
    const data = (await run('packages_outdated')).data as {
      packages: { name: string }[];
      runtimes: { kind: string; latest: string }[];
    };
    expect(data.packages.map((one) => one.name)).toEqual(['vite', 'zod', 'zod']);
    expect(data.runtimes).toEqual([expect.objectContaining({ kind: 'node', latest: '24.0.0' })]);
  });

  it('updates a package to its latest version, scanning once for the preview and the run', async () => {
    const shown = await preview('packages_update', { packages: [{ name: 'vite' }] });
    expect(shown.title).toBe('Update 1 package');
    expect(shown.fields).toEqual([
      expect.objectContaining({ label: 'vite (web)', value: '6.0.0 to 7.1.0' }),
    ]);

    const result = await run('packages_update', { packages: [{ name: 'vite' }] });
    expect(state.nodeUpdate).toHaveBeenCalledWith(
      ROOT,
      [{ ecosystem: 'node', name: 'vite', targetVersion: '7.1.0', manifestPath: WEB }],
      expect.any(Function),
    );
    expect(state.scan).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Updated 1 package: vite.');
  });

  it('updates a package in every project that has it, or only the one named', async () => {
    await run('packages_update', { packages: [{ name: 'zod', version: '4.0.0' }] });
    expect(state.nodeUpdate.mock.calls[0][1]).toEqual([
      { ecosystem: 'node', name: 'zod', targetVersion: '4.0.0', manifestPath: API },
      { ecosystem: 'node', name: 'zod', targetVersion: '4.0.0', manifestPath: WEB },
    ]);

    await run('packages_update', { packages: [{ name: 'zod', project: 'API' }] });
    expect(state.nodeUpdate.mock.calls[1][1]).toEqual([
      { ecosystem: 'node', name: 'zod', targetVersion: '4.1.0', manifestPath: API },
    ]);
  });

  it('refuses a package the project does not have, before anything runs', async () => {
    await expect(run('packages_update', { packages: [{ name: 'left-pad' }] })).rejects.toThrow(
      'This project has no package named left-pad',
    );
    expect(state.nodeUpdate).not.toHaveBeenCalled();
  });

  it('refuses a version with shell characters through the same checks as the Packages tab', async () => {
    await expect(
      run('packages_update', { packages: [{ name: 'vite', version: '7.1.0 && calc' }] }),
    ).rejects.toThrow('is not a valid version');
    expect(state.nodeUpdate).not.toHaveBeenCalled();
  });

  it('passes on which packages failed to update', async () => {
    state.nodeUpdate.mockResolvedValue({
      ok: false,
      results: [{ name: 'vite', ok: false, message: 'ERESOLVE peer conflict' }],
    });
    await expect(run('packages_update', { packages: [{ name: 'vite' }] })).rejects.toThrow(
      'vite: ERESOLVE peer conflict',
    );
  });
});
