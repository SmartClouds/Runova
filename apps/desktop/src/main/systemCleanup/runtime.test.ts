import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CacheProviderId,
  type DevOs,
  type SystemCleanEvent,
  type SystemScanEvent,
  TRASH_MARK,
} from '@runova/core';
import { describe, expect, it } from 'vitest';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { measurePath } from './engine/measure';
import { createSystemCleanup, type RuntimeDeps } from './runtime';

const os: DevOs =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

const bytes = (count: number): string => 'x'.repeat(count);

const NUGET = {
  '.nuget/packages/acornima/1.0.0/a.nupkg': bytes(10),
  '.nuget/packages/acornima/2.0.0/a.nupkg': bytes(20),
  '.nuget/packages/sass/1.1.52/s.nupkg': bytes(30),
};

interface Setup {
  home: string;
  deps: RuntimeDeps;
  logged: string[];
}

function setup(files: Record<string, string> = NUGET, extra: Partial<RuntimeDeps> = {}): Setup {
  const home = realpathSync(writeTree(tempDir(), files));
  const logged: string[] = [];
  let ids = 0;
  const deps: RuntimeDeps = {
    availability: () => ({ enabled: true, sandbox: null }),
    os,
    baseEnv: () => ({
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
    }),
    homeDir: () => home,
    protectedFolders: () => [],
    projectFolders: async () => [],
    findTools: async () => new Set<string>(),
    makeRunner: () => ({
      query: async () => null,
      runCommand: async () => ({ code: 0, cancelled: false, notFound: false, timedOut: false }),
    }),
    newId: () => `id-${++ids}`,
    now: () => 10,
    log: async (entry) => {
      logged.push(entry.label);
    },
    progressGapMs: 0,
    ...extra,
  };
  return { home, deps, logged };
}

const noop = () => undefined;

function request(extra: { providerIds?: CacheProviderId[]; signal?: AbortSignal } = {}) {
  const events: SystemScanEvent[] = [];
  return {
    events,
    request: { requestId: 'r1', onEvent: (event: SystemScanEvent) => events.push(event), ...extra },
  };
}

function cleanRequest(
  scanId: string,
  selection: Parameters<ReturnType<typeof createSystemCleanup>['clean']>[0]['selection'],
  signal?: AbortSignal,
) {
  const events: SystemCleanEvent[] = [];
  return {
    events,
    request: {
      requestId: 'c1',
      scanId,
      selection,
      signal,
      onEvent: (event: SystemCleanEvent) => events.push(event),
    },
  };
}

describe('status', () => {
  it('says it is on for a normal run', () => {
    expect(createSystemCleanup(setup().deps).status()).toEqual({ enabled: true });
  });

  it('says why it is off, and does nothing, in a test run with no sandbox', async () => {
    const { deps, home } = setup(NUGET, {
      availability: () => ({ enabled: false, reason: 'Switched off in tests.', sandbox: null }),
    });
    const service = createSystemCleanup(deps);
    expect(service.status()).toEqual({ enabled: false, reason: 'Switched off in tests.' });
    await expect(service.scan(request().request)).rejects.toThrow('Switched off in tests.');
    await expect(
      service.clean(cleanRequest('x', { mode: 'everything', providerId: 'nuget' }).request),
    ).rejects.toThrow('Switched off in tests.');
    expect(existsSync(join(home, '.nuget'))).toBe(true);
  });
});

describe('scan', () => {
  it('finds the caches on the machine and reports what is in them', async () => {
    const service = createSystemCleanup(setup().deps);
    const { request: req, events } = request({ providerIds: ['nuget'] });
    const scan = await service.scan(req);
    expect(scan.providers).toHaveLength(1);
    expect(scan.providers[0]).toMatchObject({ id: 'nuget', status: 'ready', bytes: 60 });
    expect(scan.providers[0]?.items).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'started', providers: [{ id: 'nuget' }] });
    expect(events.at(-1)).toMatchObject({ type: 'finished', cancelled: false });
  });

  it('looks at every cache it knows when none is asked for, and calls the absent ones missing', async () => {
    const service = createSystemCleanup(setup().deps);
    const scan = await service.scan(request().request);
    expect(scan.providers.length).toBeGreaterThan(10);
    expect(scan.providers.find((provider) => provider.id === 'nuget')?.status).toBe('ready');
    expect(scan.providers.find((provider) => provider.id === 'bun')?.status).toBe('missing');
  });

  it('never asks a tool where its cache is while in a sandbox', async () => {
    const asked: string[] = [];
    const { deps } = setup(NUGET, {
      availability: () => ({ enabled: true, sandbox: { env: {}, home: '' } }),
      findTools: async () => new Set(['dotnet']),
      makeRunner: () => ({
        query: async (command) => {
          asked.push(command);
          return null;
        },
        runCommand: async () => ({ code: 0, cancelled: false, notFound: false, timedOut: false }),
      }),
    });
    await createSystemCleanup(deps).scan(request({ providerIds: ['nuget'] }).request);
    expect(asked).toEqual([]);
  });

  it('uses the sandbox home and ignores the real one', async () => {
    const real = setup();
    const sandboxHome = realpathSync(writeTree(tempDir(), NUGET));
    const { deps } = setup(NUGET, {
      baseEnv: real.deps.baseEnv,
      homeDir: real.deps.homeDir,
      availability: () => ({
        enabled: true,
        sandbox: {
          home: sandboxHome,
          env: {
            HOME: sandboxHome,
            USERPROFILE: sandboxHome,
            LOCALAPPDATA: join(sandboxHome, 'AppData', 'Local'),
          },
        },
      }),
    });
    const scan = await createSystemCleanup(deps).scan(request({ providerIds: ['nuget'] }).request);
    expect(scan.providers[0]?.root).toBe(join(sandboxHome, '.nuget', 'packages'));
  });

  it('refuses a cache that turns out to be inside a project', async () => {
    const { deps, home } = setup();
    deps.projectFolders = async () => [join(home, '.nuget')];
    const scan = await createSystemCleanup(deps).scan(request({ providerIds: ['nuget'] }).request);
    expect(scan.providers[0]).toMatchObject({ status: 'unverified' });
  });

  it('works on one thing at a time', async () => {
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = setup(NUGET, {
      measure: async (...args) => {
        await gate;
        return measurePath(...args);
      },
    });
    const service = createSystemCleanup(deps);
    const first = service.scan(request({ providerIds: ['nuget'] }).request);
    await expect(service.scan(request({ providerIds: ['nuget'] }).request)).rejects.toThrow(
      /already working/i,
    );
    release();
    await first;
    await expect(service.scan(request({ providerIds: ['nuget'] }).request)).resolves.toBeDefined();
  });

  it('can be cancelled by its request id', async () => {
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = setup(NUGET, {
      measure: async (path, options) => {
        await gate;
        return measurePath(path, options);
      },
    });
    const service = createSystemCleanup(deps);
    const running = service.scan(request({ providerIds: ['nuget'] }).request);
    expect(service.cancel('r1')).toBe(true);
    expect(service.cancel('unknown')).toBe(false);
    release();
    const scan = await running;
    expect(scan.cancelled).toBe(true);
    expect(service.cancel('r1')).toBe(false);
  });

  it('finishes off a folder an earlier clean-up set aside', async () => {
    const leftover = `.nuget/packages/acornima/1.0.0${TRASH_MARK}abc/old.bin`;
    const { deps, home } = setup({ ...NUGET, [leftover]: bytes(5) });
    const service = createSystemCleanup(deps);
    await service.scan(request({ providerIds: ['nuget'] }).request);
    await service.whenTidy();
    expect(existsSync(join(home, '.nuget', 'packages', 'acornima', `1.0.0${TRASH_MARK}abc`))).toBe(
      false,
    );
    expect(existsSync(join(home, '.nuget', 'packages', 'acornima', '2.0.0'))).toBe(true);
  });
});

describe('scan, one cache after another', () => {
  it('keeps the same scan, and the other caches in it, when one cache is looked at again', async () => {
    const { deps, home } = setup({
      ...NUGET,
      '.bun/install/cache/react@19.0.0@@@1/package.json': bytes(5),
    });
    const service = createSystemCleanup(deps);
    const first = await service.scan(request({ providerIds: ['nuget'] }).request);
    const second = await service.scan(request({ providerIds: ['bun'] }).request);
    expect(second.scanId).toBe(first.scanId);
    expect(second.providers.map((provider) => provider.id).sort()).toEqual(['bun', 'nuget']);
    writeFileSync(join(home, '.nuget', 'packages', 'sass', '1.1.52', 'more.bin'), bytes(100));
    const third = await service.scan(request({ providerIds: ['nuget'] }).request);
    expect(third.scanId).toBe(first.scanId);
    expect(third.providers.find((provider) => provider.id === 'nuget')?.bytes).toBe(160);
  });

  it('starts a new scan when everything is looked at again', async () => {
    const service = createSystemCleanup(setup().deps);
    const first = await service.scan(request({ providerIds: ['nuget'] }).request);
    const second = await service.scan(request().request);
    expect(second.scanId).not.toBe(first.scanId);
  });

  it('keeps what it knew about a cache when looking at it again is cut short', async () => {
    const { deps } = setup();
    const service = createSystemCleanup(deps);
    const first = await service.scan(request({ providerIds: ['nuget'] }).request);
    const controller = new AbortController();
    controller.abort();
    const second = await service.scan(
      request({ providerIds: ['nuget'], signal: controller.signal }).request,
    );
    expect(second.providers.find((provider) => provider.id === 'nuget')).toEqual(
      first.providers.find((provider) => provider.id === 'nuget'),
    );
  });
});

describe('clean', () => {
  it('cleans up from the scan it made, and brings the scan up to date', async () => {
    const { deps, home, logged } = setup();
    const service = createSystemCleanup(deps);
    const scan = await service.scan(request({ providerIds: ['nuget'] }).request);
    const { request: req, events } = cleanRequest(scan.scanId, {
      mode: 'old-versions',
      providerId: 'nuget',
      keep: 1,
    });
    const result = await service.clean(req);
    expect(result).toMatchObject({ removed: 1, freedBytes: 10 });
    expect(existsSync(join(home, '.nuget', 'packages', 'acornima', '1.0.0'))).toBe(false);
    expect(existsSync(join(home, '.nuget', 'packages', 'acornima', '2.0.0'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'finished', cancelled: false });
    expect(logged).toEqual(['acornima 1.0.0']);
    expect(service.current()?.providers.find((p) => p.id === 'nuget')?.bytes).toBe(50);
  });

  it('refuses when nothing has been scanned yet', async () => {
    const service = createSystemCleanup(setup().deps);
    await expect(
      service.clean(cleanRequest('whatever', { mode: 'everything', providerId: 'nuget' }).request),
    ).rejects.toThrow(/scan/i);
  });

  it('refuses a scan id that is not the current one', async () => {
    const { deps, home } = setup();
    const service = createSystemCleanup(deps);
    await service.scan(request({ providerIds: ['nuget'] }).request);
    await expect(
      service.clean(cleanRequest('forged', { mode: 'everything', providerId: 'nuget' }).request),
    ).rejects.toThrow(/out of date/i);
    expect(existsSync(join(home, '.nuget', 'packages', 'sass'))).toBe(true);
  });

  it('keeps cleaning when the record of it cannot be written', async () => {
    const { deps, home } = setup(NUGET, {
      log: async () => {
        throw new Error('disk full');
      },
    });
    const service = createSystemCleanup(deps);
    const scan = await service.scan(request({ providerIds: ['nuget'] }).request);
    const result = await service.clean(
      cleanRequest(scan.scanId, { mode: 'old-versions', providerId: 'nuget', keep: 1 }).request,
    );
    expect(result.removed).toBe(1);
    expect(existsSync(join(home, '.nuget', 'packages', 'acornima', '1.0.0'))).toBe(false);
  });

  it('works on one thing at a time while a clean-up runs, and the clean-up can be cancelled', async () => {
    const { deps, home } = setup({ 'npmc/_cacache/content/a.bin': bytes(50) });
    deps.baseEnv = () => ({
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      npm_config_cache: join(home, 'npmc'),
    });
    deps.findTools = async () => new Set(['npm']);
    deps.makeRunner = () => ({
      query: async () => null,
      runCommand: (_action, _onLine, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () =>
            resolve({ code: null, cancelled: true, notFound: false, timedOut: false }),
          );
        }),
    });
    const service = createSystemCleanup(deps);
    const scan = await service.scan(request({ providerIds: ['nuget'] }).request);
    expect(scan.providers).toHaveLength(1);
    const npmScan = await service.scan(request({ providerIds: ['npm'] }).request);
    expect(npmScan.providers.find((p) => p.id === 'npm')).toMatchObject({ status: 'ready' });

    const running = service.clean(
      cleanRequest(npmScan.scanId, { mode: 'clear-command', providerId: 'npm' }).request,
    );
    await expect(service.scan(request({ providerIds: ['nuget'] }).request)).rejects.toThrow(
      /already working/i,
    );
    expect(service.cancel('c1')).toBe(true);
    expect((await running).cancelled).toBe(true);
  });
});

describe('rootOf', () => {
  it('names the folder a cache lives in, for showing it in the file manager', async () => {
    const { deps, home } = setup();
    const service = createSystemCleanup(deps);
    expect(await service.rootOf('nuget')).toBe(join(home, '.nuget', 'packages'));
    expect(await service.rootOf('bun')).toBeNull();
  });

  it('gives nothing in a sandbox-less test run', async () => {
    const { deps } = setup(NUGET, {
      availability: () => ({ enabled: false, reason: 'off', sandbox: null }),
    });
    expect(await createSystemCleanup(deps).rootOf('nuget')).toBeNull();
  });
});
