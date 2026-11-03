import { findCatalogTemplate, generateCatalogSecrets, renderCatalogApp } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type {
  JobInfo,
  StackDetails,
  StackInfo,
  StackRevisionInfo,
  StackRevisionUpload,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployAppReleases } from '../../../shared/deployAppStoreTypes';
import { type AppStoreStacks, DeployAppStore } from './service';

/**
 * The App Store's main-process side: an install is rendered again here from what was picked
 * (never taken as a file from the renderer), goes up as a new app and deploys; an update renders
 * the newer compose file and has the server copy the live revision with it, keeping its .env.
 */

const SERVER = 'srv-1';
const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const JOB = { id: 'job-1' } as unknown as JobInfo;

const redis = findCatalogTemplate('redis');
const postgres = findCatalogTemplate('postgres');
if (!redis || !postgres) throw new Error('the catalog lost redis or postgres');

const INFO: StackInfo = {
  id: STACK,
  name: 'cache',
  status: 'new',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
  revisionCount: 1,
  runningContainers: 0,
  containers: 0,
};

const revision = (extra: Partial<StackRevisionInfo> = {}): StackRevisionInfo => ({
  stackId: STACK,
  number: 1,
  state: 'ready',
  createdAtUnixMs: 2,
  composeSha256: 'abc',
  envKeys: ['REDIS_PASSWORD'],
  services: ['redis'],
  proxiedServices: ['redis'],
  hasBuildContext: false,
  steps: [],
  findings: [],
  acknowledgedRisks: [],
  unacknowledgedRisks: [],
  bindings: [],
  ...extra,
});

const REDIS = 'docker.io/library/redis';
const NEWER = `sha256:${'e'.repeat(64)}` as const;

/** The registries had a newer Redis 8 than the one the catalog pins. */
const READING: DeployAppReleases = {
  data: {
    checkedAt: '2026-11-03',
    repositories: { [REDIS]: [{ tag: '8.10.9', digest: NEWER }] },
  },
  checkedAtUnixMs: 1,
  error: null,
};

function harness(stacks: Partial<AppStoreStacks> = {}, reading: DeployAppReleases = READING) {
  const uploads: StackRevisionUpload[] = [];
  const fake: AppStoreStacks = {
    createFromFiles: vi.fn(async (_server, _name, _description, upload) => {
      uploads.push(upload);
      return { stack: INFO, revision: revision() };
    }),
    deploy: vi.fn(async () => JOB),
    get: vi.fn(async () => ({ stack: INFO, revisions: [revision()], services: [] })),
    files: vi.fn(async () => ({ number: 1, compose: '', envKeys: [] })),
    reviseAndDeploy: vi.fn(async () => ({ revision: revision({ number: 2 }), job: JOB })),
    revealEnv: vi.fn(async () => []),
    ...stacks,
  };
  const releases = { get: vi.fn(async () => reading) };
  return { store: new DeployAppStore({ stacks: fake, releases }), stacks: fake, uploads, releases };
}

const INSTALL = {
  serverId: SERVER,
  templateId: 'redis',
  version: '8.10',
  name: 'cache',
  params: { port: 16390 },
  secrets: generateCatalogSecrets(redis.secrets),
  domain: null,
};

describe('DeployAppStore.install', () => {
  it('renders the files here, creates the app and deploys it', async () => {
    const { store, stacks, uploads } = harness();
    const result = await store.install(INSTALL);
    expect(stacks.createFromFiles).toHaveBeenCalledWith(
      SERVER,
      'cache',
      'Redis from the App Store',
      expect.anything(),
    );
    const [upload] = uploads;
    expect(upload.compose).toContain('127.0.0.1:16390:6379');
    expect(upload.compose).not.toContain(INSTALL.secrets.REDIS_PASSWORD);
    expect(upload.env).toContain(INSTALL.secrets.REDIS_PASSWORD);
    expect(upload.proxiedServices).toEqual(['redis']);
    expect(upload.buildContext).toBe(false);
    expect(stacks.deploy).toHaveBeenCalledWith(SERVER, STACK, 1);
    expect(result).toEqual({ stack: INFO, revision: revision(), job: JOB });
  });

  it('refuses an unknown app, a weak secret and parameters that do not fit, before any upload', async () => {
    const { store, stacks } = harness();
    await expect(store.install({ ...INSTALL, templateId: 'minio' })).rejects.toThrow(
      'The App Store has no app called minio.',
    );
    await expect(
      store.install({ ...INSTALL, secrets: { REDIS_PASSWORD: 'short' } }),
    ).rejects.toThrow('at least 16 characters');
    await expect(store.install({ ...INSTALL, params: { port: 70000 } })).rejects.toThrow(
      'Ports go from 1 to 65535.',
    );
    expect(stacks.createFromFiles).not.toHaveBeenCalled();
  });

  it('installs the newest release the registries listed, pinned by its digest', async () => {
    const { store, uploads } = harness();
    await store.install(INSTALL);
    expect(uploads[0].compose).toContain(`${REDIS}:8.10.9@${NEWER}`);
    expect(uploads[0].compose).toContain('Redis 8.10.9');
  });

  it('installs a release picked from the list, and the bundled one without a reading', async () => {
    const picked = harness();
    await picked.store.install({ ...INSTALL, release: '8.10.2' });
    expect(picked.uploads[0].compose).toContain(`${REDIS}:8.10.2@sha256:`);
    expect(picked.uploads[0].compose).not.toContain(NEWER);

    const offline = harness({}, { data: null, checkedAtUnixMs: null, error: 'down' });
    await offline.store.install(INSTALL);
    expect(offline.uploads[0].compose).toContain(`${REDIS}:8.10.2@sha256:`);
  });

  it('refuses a release the version picker never listed', async () => {
    const { store, stacks } = harness();
    await expect(store.install({ ...INSTALL, release: '9.0.0' })).rejects.toThrow(
      'Redis has no release 9.0.0 on this line.',
    );
    expect(stacks.createFromFiles).not.toHaveBeenCalled();
  });

  it('sends the resource caps with the upload', async () => {
    const { store, uploads } = harness();
    await store.install({
      ...INSTALL,
      limits: [{ service: 'redis', cpuCores: 1, cpuPercent: 50, memoryMb: 256 }],
    });
    expect(uploads[0].limits).toEqual([
      { service: 'redis', cpuCores: 1, cpuPercent: 50, memoryMb: 256 },
    ]);
  });

  it('refuses caps on a service the app does not have', async () => {
    const { store, stacks } = harness();
    await expect(
      store.install({ ...INSTALL, limits: [{ service: 'web', memoryMb: 256 }] }),
    ).rejects.toThrow('There is no service called web in this app.');
    expect(stacks.createFromFiles).not.toHaveBeenCalled();
  });

  it('leaves a revision the server refused undeployed', async () => {
    const { store, stacks } = harness({
      createFromFiles: async () => ({ stack: INFO, revision: revision({ state: 'invalid' }) }),
    });
    const result = await store.install(INSTALL);
    expect(result.job).toBeNull();
    expect(stacks.deploy).not.toHaveBeenCalled();
  });
});

describe('DeployAppStore.update', () => {
  function installed(version: string) {
    const out = renderCatalogApp(postgres as NonNullable<typeof postgres>, {
      version,
      params: { port: 15440 },
      secrets: generateCatalogSecrets((postgres as NonNullable<typeof postgres>).secrets),
    });
    if (!out.ok) throw new Error(out.reason);
    return out.render;
  }

  const details = (envKeys: string[]): StackDetails => ({
    stack: { ...INFO, name: 'db', liveRevision: 1 },
    revisions: [revision({ state: 'live', envKeys, proxiedServices: ['postgres'] })],
    services: [],
  });

  it('has the server copy the live revision with the newer compose file and no env', async () => {
    const old = installed('17');
    const { store, stacks } = harness({
      get: async () => details(Object.keys(old.env)),
      files: vi.fn(async () => ({
        number: 1,
        compose: old.compose,
        envKeys: Object.keys(old.env),
      })),
    });
    const result = await store.update({ serverId: SERVER, stackId: STACK, version: '18' });
    expect(stacks.files).toHaveBeenCalledWith(SERVER, STACK, 1);
    const [[server, request]] = (stacks.reviseAndDeploy as ReturnType<typeof vi.fn>).mock.calls;
    expect(server).toBe(SERVER);
    expect(request).toMatchObject({
      stackId: STACK,
      revision: 1,
      proxiedServices: ['postgres'],
      purpose: 'update',
      acknowledgedRisks: [],
    });
    expect(request.compose).toContain('version: "18"');
    expect(request).not.toHaveProperty('env');
    expect(result.job).toBe(JOB);
  });

  it('moves to the newest release of the line the registries listed', async () => {
    const old = installed('18');
    const newest = `sha256:${'f'.repeat(64)}` as const;
    const { store, stacks } = harness(
      {
        get: async () => details(Object.keys(old.env)),
        files: vi.fn(async () => ({
          number: 1,
          compose: old.compose,
          envKeys: Object.keys(old.env),
        })),
      },
      {
        data: {
          checkedAt: '2026-11-03',
          repositories: { 'docker.io/library/postgres': [{ tag: '18.9', digest: newest }] },
        },
        checkedAtUnixMs: 1,
        error: null,
      },
    );
    await store.update({ serverId: SERVER, stackId: STACK, version: '18' });
    const [[, request]] = (stacks.reviseAndDeploy as ReturnType<typeof vi.fn>).mock.calls;
    expect(request.compose).toContain(`postgres:18.9@${newest}`);
  });

  it('refuses an app that is not from the App Store, and a version that needs a missing secret', async () => {
    const notStore = harness({
      files: async () => ({ number: 1, compose: 'services: {}\n', envKeys: [] }),
    });
    await expect(
      notStore.store.update({ serverId: SERVER, stackId: STACK, version: '18' }),
    ).rejects.toThrow('not installed from the App Store');

    const old = installed('17');
    const missing = harness({
      get: async () => details([]),
      files: async () => ({ number: 1, compose: old.compose, envKeys: [] }),
    });
    await expect(
      missing.store.update({ serverId: SERVER, stackId: STACK, version: '18' }),
    ).rejects.toThrow('POSTGRES_PASSWORD');
    expect(missing.stacks.reviseAndDeploy).not.toHaveBeenCalled();
  });
});

describe('DeployAppStore.releases', () => {
  it('hands back the reading, fresh when asked', async () => {
    const { store, releases } = harness();
    await expect(store.releases({ refresh: true })).resolves.toBe(READING);
    expect(releases.get).toHaveBeenCalledWith({ refresh: true });
  });
});

describe('DeployAppStore.revealSecrets', () => {
  it('hands back the .env as a map', async () => {
    const { store } = harness({
      revealEnv: async () => [{ key: 'REDIS_PASSWORD', value: 'Abc1234567890defg' }],
    });
    await expect(
      store.revealSecrets({ serverId: SERVER, stackId: STACK, revision: 1, password: 'pw' }),
    ).resolves.toEqual({ REDIS_PASSWORD: 'Abc1234567890defg' });
  });
});
