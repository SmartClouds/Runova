import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeUpdateRequest } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { expectChannelsCovered, invoke, loadIpc } from '../../test/main/ipcHarness';

/**
 * Everything the Packages tab sends ends up as a file write or a CLI argument in the project's
 * folder, so main checks it against what the list could have produced before any adapter sees it.
 */

const ROOT = join('C:', 'work', 'shop');

const state = vi.hoisted(() => ({
  scan: vi.fn(),
  nodeUpdate: vi.fn(),
  dartRuntime: vi.fn(),
  nodeRuntime: vi.fn(),
  detect: vi.fn(),
  upload: vi.fn(),
}));

// The new versions go up for dependency alerts; the account itself is not part of these tests.
vi.mock('../account/live', () => ({ getDependencyAlerts: () => ({ upload: state.upload }) }));

vi.mock('../worktrees/resolve', () => ({
  findProjectScope: async (id: string) => (id === 'p1' ? { id, folderPath: ROOT } : null),
}));

vi.mock('../packageManagers', () => ({
  scanProjectPackages: state.scan,
  PACKAGE_MANAGER_ADAPTERS: [
    { ecosystem: 'node', updatePackages: state.nodeUpdate, updateRuntime: state.nodeRuntime },
    { ecosystem: 'dart', updatePackages: vi.fn(), updateRuntime: state.dartRuntime },
    { ecosystem: 'python', updatePackages: state.nodeUpdate, updateRuntime: vi.fn() },
    { ecosystem: 'rust', updatePackages: state.nodeUpdate, updateRuntime: vi.fn() },
    { ecosystem: 'kotlin', updatePackages: state.nodeUpdate, updateRuntime: vi.fn() },
    { ecosystem: 'swift', updatePackages: state.nodeUpdate, updateRuntime: vi.fn() },
  ],
}));

// The real runtime probes the machine and reads the settings store.
vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => ({ detect: state.detect }),
}));

expectChannelsCovered(IPC.packages, [IPC.packages.onUpdateProgress]);

beforeEach(async () => {
  for (const fn of Object.values(state)) fn.mockReset();
  await loadIpc(
    () => import('./packageManagers'),
    (module) => module.registerPackageManagerHandlers(),
  );
});

function runtimeRequest(overrides: Partial<RuntimeUpdateRequest> = {}): RuntimeUpdateRequest {
  return {
    ecosystem: 'dart',
    source: 'pubspec-sdk',
    kind: 'dart',
    manifestPath: join(ROOT, 'app', 'pubspec.yaml'),
    targetVersion: '3.13.5',
    ...overrides,
  };
}

describe('packages:list', () => {
  it('scans the folder of the project', async () => {
    state.scan.mockResolvedValue([]);

    await expect(invoke(IPC.packages.list, 'p1')).resolves.toEqual({
      projectId: 'p1',
      sections: [],
    });
    expect(state.scan).toHaveBeenCalledWith(ROOT);
  });
});

describe('packages:update', () => {
  it('refuses a manifest outside the project before running anything', async () => {
    const result = await invoke(IPC.packages.update, 'p1', [
      {
        ecosystem: 'node',
        name: 'left-pad',
        targetVersion: '1.3.0',
        manifestPath: join('C:', 'elsewhere', 'package.json'),
      },
    ]);

    expect(result).toMatchObject({ ok: false });
    expect(state.nodeUpdate).not.toHaveBeenCalled();
  });

  it('sends the new package list up for dependency alerts once an update ran', async () => {
    state.upload.mockResolvedValue({ uploaded: 1, skipped: 0 });
    state.nodeUpdate.mockResolvedValue({ ok: true, results: [] });

    await invoke(IPC.packages.update, 'p1', [
      {
        ecosystem: 'node',
        name: 'left-pad',
        targetVersion: '1.3.0',
        manifestPath: join(ROOT, 'package.json'),
      },
    ]);

    expect(state.upload).toHaveBeenCalledTimes(1);
  });
});

describe('package names of the newer ecosystems', () => {
  async function tryName(ecosystem: string, name: string) {
    state.nodeUpdate.mockResolvedValue({ ok: true, results: [] });
    await invoke(IPC.packages.update, 'p1', [
      { ecosystem, name, targetVersion: '1.2.3', manifestPath: join(ROOT, 'manifest') },
    ]);
    return state.nodeUpdate.mock.calls.length > 0;
  }

  it.each([
    ['python', 'Django'],
    ['python', 'zope.interface'],
    ['rust', 'serde_json'],
    ['kotlin', 'androidx.core:core-ktx'],
    ['kotlin', 'com.android.application'],
    ['swift', 'swift-log'],
    ['swift', 'Firebase/Analytics'],
  ])('passes the real %s name %s', async (ecosystem, name) => {
    await expect(tryName(ecosystem, name)).resolves.toBe(true);
  });

  it.each([
    ['python', 'a b'],
    ['python', 'requests>=1'],
    ['rust', 'serde@1'],
    ['rust', '--help'],
    ['kotlin', 'a:b:c'],
    ['kotlin', '"x'],
    ['swift', '../../evil'],
    ['swift', 'a&b'],
  ])('refuses %s name %s before running anything', async (ecosystem, name) => {
    await expect(tryName(ecosystem, name)).resolves.toBe(false);
  });
});

describe('packages:updateRuntime', () => {
  it('hands a valid request to the adapter of its ecosystem', async () => {
    state.dartRuntime.mockResolvedValue({ ok: true, message: 'Updated' });

    await expect(invoke(IPC.packages.updateRuntime, 'p1', runtimeRequest())).resolves.toEqual({
      ok: true,
      message: 'Updated',
    });
    expect(state.dartRuntime).toHaveBeenCalledWith(ROOT, runtimeRequest(), expect.any(Object));
    expect(state.nodeRuntime).not.toHaveBeenCalled();
  });

  it('reads the installed toolchain from Dev Setup, and nothing for an unknown id', async () => {
    state.detect.mockResolvedValue({ state: 'found', version: '3.47.7', path: 'x', onPath: true });
    state.dartRuntime.mockResolvedValue({ ok: true, message: 'Updated' });

    await invoke(IPC.packages.updateRuntime, 'p1', runtimeRequest());
    const deps = state.dartRuntime.mock.calls[0][2];

    await expect(deps.installedVersion('flutter')).resolves.toBe('3.47.7');
    expect(state.detect).toHaveBeenCalledWith('flutter', { force: true });
    await expect(deps.installedVersion('not-a-tool')).resolves.toBeNull();

    state.detect.mockResolvedValue({ state: 'absent' });
    await expect(deps.installedVersion('flutter')).resolves.toBeNull();
  });

  it.each([
    [
      'a file outside the project',
      { manifestPath: join('C:', 'elsewhere', 'pubspec.yaml') },
      /outside the project folder/,
    ],
    [
      'a file that does not hold that setting',
      { manifestPath: join(ROOT, 'app', 'build.gradle') },
      /is not where that setting is kept/,
    ],
    ['a version with shell characters', { targetVersion: '3.13.5 && calc' }, /not a valid version/],
    ['a source that does not exist', { source: 'dockerfile' }, /Unknown runtime setting/],
    ['a source from another ecosystem', { ecosystem: 'node' }, /Unknown runtime setting/],
    ['a runtime the source cannot name', { kind: 'bun' }, /Unknown runtime setting/],
  ] as const)('refuses %s', async (_label, overrides, message) => {
    const result = await invoke<{ ok: boolean; message: string }>(
      IPC.packages.updateRuntime,
      'p1',
      runtimeRequest(overrides as Partial<RuntimeUpdateRequest>),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(message);
    expect(state.dartRuntime).not.toHaveBeenCalled();
    expect(state.nodeRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['python', 'requires-python', 'python', 'pyproject.toml'],
    ['python', 'poetry-python', 'python', 'pyproject.toml'],
    ['python', 'pipfile-python', 'python', 'Pipfile'],
    ['python', 'python-version-file', 'python', '.python-version'],
    ['rust', 'rust-version', 'rust', 'Cargo.toml'],
    ['rust', 'rust-toolchain', 'rust', 'rust-toolchain.toml'],
    ['rust', 'rust-toolchain', 'rust', 'rust-toolchain'],
    ['kotlin', 'gradle-wrapper', 'gradle', 'gradle-wrapper.properties'],
    ['kotlin', 'android-compile-sdk', 'android', 'build.gradle.kts'],
    ['kotlin', 'android-target-sdk', 'android', 'build.gradle'],
    ['swift', 'swift-tools', 'swift', 'Package.swift'],
  ] as const)('accepts %s %s in %s %s', async (ecosystem, source, kind, file) => {
    const { rejectUnsafeRuntimeUpdate } = await import('./packageManagers');

    expect(
      rejectUnsafeRuntimeUpdate(
        { ecosystem, source, kind, manifestPath: join(ROOT, file), targetVersion: '1.2.3' },
        ROOT,
      ),
    ).toBeNull();
  });

  it.each([
    ['python', 'requires-python', 'python', 'setup.py'],
    ['rust', 'rust-version', 'rust', 'package.json'],
    ['kotlin', 'gradle-wrapper', 'gradle', 'build.gradle'],
    ['kotlin', 'android-compile-sdk', 'android', 'settings.gradle'],
    ['swift', 'swift-tools', 'swift', 'Podfile'],
  ] as const)('refuses %s %s named on %s %s', async (ecosystem, source, kind, file) => {
    const { rejectUnsafeRuntimeUpdate } = await import('./packageManagers');

    expect(
      rejectUnsafeRuntimeUpdate(
        { ecosystem, source, kind, manifestPath: join(ROOT, file), targetVersion: '1.2.3' },
        ROOT,
      ),
    ).toMatch(/is not where that setting is kept/);
  });

  it('accepts each file a .NET target framework can live in', async () => {
    const { rejectUnsafeRuntimeUpdate } = await import('./packageManagers');
    const dotnet = (file: string, source: 'target-framework' | 'global-json') =>
      rejectUnsafeRuntimeUpdate(
        {
          ecosystem: 'dotnet',
          source,
          kind: 'dotnet',
          manifestPath: join(ROOT, file),
          targetVersion: '10.0',
        },
        ROOT,
      );

    expect(dotnet(join('src', 'Api.csproj'), 'target-framework')).toBeNull();
    expect(dotnet(join('src', 'Lib.fsproj'), 'target-framework')).toBeNull();
    expect(dotnet('Directory.Build.props', 'target-framework')).toBeNull();
    expect(dotnet('global.json', 'global-json')).toBeNull();
    expect(dotnet('global.json', 'target-framework')).toMatch(/is not where that setting is kept/);
  });
});
