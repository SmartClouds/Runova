import { readFileSync } from 'node:fs';
import { buildHealthSpecMarkdown, HEALTH_ENV } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HealthCreateResult,
  HealthSecretReveal,
  HealthSetupPrompt,
  HealthTargetDetail,
  HealthTargetInput,
  HealthTargetSummary,
} from '../../shared/healthTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { json, type LocalServer, startHttpServer, tempDir } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import type { HeadlessPromptResult } from '../cli/headlessPrompt';
import { sha256Hex } from '../health/token';

/**
 * The Health page's channels. The one rule above the rest: a target's key or password comes back
 * exactly twice in its life, from create and from rotate, and never in any other payload. The
 * probes here run for real over the app's net.fetch (Node's fetch in the electron mock) against
 * a local endpoint, so the key that is checked is the one that was actually sent.
 */

const cli = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<HeadlessPromptResult>>(),
  cancel: vi.fn(() => true),
}));

vi.mock('../cli/headlessPrompt', () => ({
  runHeadlessCliPrompt: cli.run,
  cancelHeadlessPrompt: cli.cancel,
}));

/**
 * The account, signed out unless a test signs it in, with a small website API for the online
 * monitors. The real runtime brings the whole sync engine with it, which took a cold CI machine
 * past the test's time limit to load, and the online monitors only need these three things of it.
 */
const account = vi.hoisted(() => {
  type Monitor = Record<string, unknown> & { id: number; itemId: string };
  const state = {
    signedIn: false,
    monitors: new Map<number, Monitor>(),
    calls: [] as { method: string; path: string; body?: unknown }[],
    nextId: 41,
  };
  const status = {
    verdict: 'unknown',
    state: null,
    lastCheckedAt: null,
    latencyMs: null,
    httpStatus: null,
    problem: null,
    region: null,
    confirming: false,
    openIncident: null,
    uptime24h: null,
  };
  async function api(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!state.signedIn) throw new Error('Sign in to your Runova account first.');
    state.calls.push({ method, path, body });
    if (method === 'GET' && path === '/cloud-monitors') {
      return { items: [...state.monitors.values()] };
    }
    if (method === 'GET' && path === '/cloud-monitors/usage') {
      return {
        scopes: [
          {
            scopeId: 5,
            name: 'Personal',
            canWrite: true,
            accountTypeName: 'Go',
            maxMonitors: 10,
            minIntervalSec: 300,
            active: state.monitors.size,
          },
        ],
      };
    }
    if (method === 'GET' && path === '/accounts/me/telegram-links/current') {
      return { linked: false };
    }
    if (method === 'POST' && path === '/cloud-monitors') {
      const sent = body as Record<string, unknown> & { itemId: string };
      const made: Monitor = {
        ...sent,
        id: state.nextId++,
        scopeId: 5,
        suspendedReason: null,
        muted: false,
        canWrite: true,
        status,
        version: '1',
      };
      state.monitors.set(made.id, made);
      return made;
    }
    const one = /^\/cloud-monitors\/(\d+)(\/.*)?$/.exec(path);
    const monitor = one ? state.monitors.get(Number(one[1])) : undefined;
    if (!one || !monitor) throw new Error(`No route for ${method} ${path}`);
    const rest = one[2] ?? '';
    if (method === 'DELETE' && rest === '') {
      state.monitors.delete(monitor.id);
      return undefined;
    }
    if (method === 'PATCH' && rest === '') {
      const updated = { ...monitor, ...(body as object) };
      state.monitors.set(monitor.id, updated);
      return updated;
    }
    if (rest === '/samples' || rest === '/hours' || rest.startsWith('/incidents')) {
      return { items: [] };
    }
    return undefined;
  }
  return { state, api };
});

vi.mock('../account/live', () => ({
  getAccountRuntime: () => ({
    status: async () =>
      account.state.signedIn
        ? { state: 'signed-in', deviceId: 'test-device' }
        : { state: 'signed-out', deviceId: 'test-device' },
    api: account.api,
    projectPlacements: async () =>
      new Map([
        ['p1', { scopeId: 5, canWrite: true }],
        ['p2', { scopeId: 5, canWrite: true }],
      ]),
  }),
}));

const userData = useTempUserData();
// onChanged is main to renderer, checked through the windows' sent messages instead.
expectChannelsCovered(IPC.health, [IPC.health.onChanged]);

let endpoint: LocalServer;
let respond: { status: number; body: unknown } = { status: 200, body: { status: 'pass' } };
const sent: string[] = [];

function input(overrides: Partial<HealthTargetInput> = {}): HealthTargetInput {
  return {
    projectId: 'p1',
    environmentId: 'e1',
    name: 'API',
    serverLabel: 'web-1',
    serverLink: null,
    url: `${endpoint.url}/_runova/health`,
    intervalSec: 60,
    timeoutSec: 5,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: false,
    ...overrides,
  };
}

/** Everything a payload could hide a secret in. */
function expectNoSecret(payload: unknown, secret: string) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain(secret);
  expect(text).not.toContain('secretEnvelope');
  expect(text).not.toContain('ciphertext');
}

async function create(overrides: Partial<HealthTargetInput> = {}) {
  return invoke<HealthCreateResult>(IPC.health.create, input(overrides));
}

const failing = {
  status: 'fail',
  checks: {
    'postgres:connection': [
      { status: 'fail', output: 'connect ECONNREFUSED', runova: { detail: 'password=hunter2' } },
    ],
  },
};

beforeEach(async () => {
  account.state.signedIn = false;
  account.state.monitors.clear();
  account.state.calls.length = 0;
  account.state.nextId = 41;
  respond = { status: 200, body: { status: 'pass' } };
  sent.length = 0;
  endpoint = await startHttpServer((request, response) => {
    sent.push(String(request.headers.authorization ?? ''));
    json(response, respond.body, respond.status);
  });
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    { id: 'p2', name: 'Blog', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
  ]);
  userData.writeData('project-environments.json', [
    {
      id: 'e1',
      projectId: 'p1',
      name: 'Production',
      kind: 'production',
      order: 0,
      files: [],
      credentials: [],
    },
  ]);
  cli.run.mockReset();
  cli.run.mockResolvedValue({
    ok: true,
    text: 'Likely cause: the database is down.',
    cliName: 'Claude Code',
  });
  cli.cancel.mockClear();
  const electron = await import('../../test/main/electronMock');
  electron.net.fetch.mockImplementation((url: string, init: RequestInit) => fetch(url, init));
  await loadIpc(
    () => import('./health'),
    (module) => module.registerHealthHandlers(),
  );
  return () => endpoint.close();
});

describe('create and rotate, the only two that reveal a secret', () => {
  it('makes a Bearer key, keeps only its sealed form and reveals it once', async () => {
    const window = new FakeBrowserWindow();
    const { target, secret } = await create();
    expect(secret).toEqual({
      targetId: target.id,
      authMode: 'bearer',
      secret: expect.stringMatching(/^rnh_[A-Za-z0-9_-]{43}$/),
      sha256: sha256Hex(secret.secret),
      basicUser: null,
      hashEnvVar: HEALTH_ENV.tokenHash,
    } satisfies HealthSecretReveal);
    expect(target).toMatchObject({ name: 'API', hasSecret: true, state: 'pending', paused: false });
    expectNoSecret(target, secret.secret);
    expect(readFileSync(userData.dataFile('health-targets.json'), 'utf-8')).not.toContain(
      secret.secret,
    );
    expect(window.webContents.sentOn(IPC.health.onChanged)).toEqual([[{ targetIds: [target.id] }]]);
  });

  it('makes a Basic password with the password hash variable', async () => {
    const { secret } = await create({ authMode: 'basic', basicUser: 'runova' });
    expect(secret).toMatchObject({
      authMode: 'basic',
      basicUser: 'runova',
      hashEnvVar: HEALTH_ENV.passwordHash,
    });
    expect(secret.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(secret.sha256).toBe(sha256Hex(secret.secret));
  });

  it('rotates to a new key that the next probe sends', async () => {
    const { target, secret } = await create();
    const rotated = await invoke<HealthSecretReveal>(IPC.health.rotateSecret, target.id);
    expect(rotated.secret).not.toBe(secret.secret);
    expect(rotated.sha256).toBe(sha256Hex(rotated.secret));
    const [listed] = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(listed.secretRotatedAt).toEqual(expect.any(Number));
    expectNoSecret(listed, rotated.secret);

    await invoke(IPC.health.checkNow, target.id);
    expect(sent).toEqual([`Bearer ${rotated.secret}`]);
  });

  it('says the vault is locked instead of saving a key it cannot seal', async () => {
    const { randomBytes } = await import('node:crypto');
    const { deriveKey, encryptWithKey } = await import('../crypto/aesGcm');
    const salt = randomBytes(16).toString('base64');
    const key = await deriveKey('a passkey nobody typed', salt);
    userData.writeData('ssh-vault.json', {
      salt,
      verifier: Buffer.from(JSON.stringify(encryptWithKey('runova-ssh-vault', key))).toString(
        'base64',
      ),
    });
    await expect(create()).rejects.toThrow('The vault is locked.');
  });
});

describe('reading targets', () => {
  it('lists summaries, optionally for one project, with no secret in them', async () => {
    const { target, secret } = await create();
    const other = await create({ projectId: 'p2', environmentId: null, name: 'Blog' });
    const all = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(all.map((one) => one.id)).toEqual([target.id, other.target.id]);
    expectNoSecret(all, secret.secret);
    expectNoSecret(all, other.secret.secret);
    const shop = await invoke<HealthTargetSummary[]>(IPC.health.list, { projectId: 'p1' });
    expect(shop.map((one) => one.id)).toEqual([target.id]);
  });

  it('gets the detail of one target, or null when it is gone', async () => {
    const { target, secret } = await create();
    const detail = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
    expect(detail).toMatchObject({ report: null, incidents: [], samples: [] });
    expectNoSecret(detail, secret.secret);
    expect(await invoke(IPC.health.get, 'missing')).toBeNull();
  });

  it('returns the protocol document', async () => {
    expect(await invoke(IPC.health.spec)).toBe(buildHealthSpecMarkdown());
  });
});

describe('editing targets', () => {
  it('updates a target and keeps its key', async () => {
    const { target, secret } = await create();
    const updated = await invoke<HealthTargetSummary>(IPC.health.update, target.id, {
      name: '  Storefront ',
      intervalSec: 300,
    });
    expect(updated).toMatchObject({ id: target.id, name: 'Storefront', intervalSec: 300 });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(target.updatedAt);
    expectNoSecret(updated, secret.secret);
    await invoke(IPC.health.checkNow, target.id);
    expect(sent).toEqual([`Bearer ${secret.secret}`]);
  });

  it('keeps the app a target was added from, until an edit unlinks it', async () => {
    const link = { serverId: 'srv-1', stackId: 'shop' };
    const { target } = await create({ appLink: link });
    expect(target.appLink).toEqual(link);
    const renamed = await invoke<HealthTargetSummary>(IPC.health.update, target.id, {
      name: 'Shop',
    });
    expect(renamed.appLink).toEqual(link);
    const unlinked = await invoke<HealthTargetSummary>(IPC.health.update, target.id, {
      appLink: null,
    });
    expect(unlinked.appLink).toBeNull();
    await expect(
      invoke(IPC.health.update, target.id, { appLink: { serverId: '', stackId: 'x' } }),
    ).rejects.toThrow(/appLink/);
  });

  it('shows the version the endpoint reports, until an edit turns it off', async () => {
    respond = { status: 200, body: { status: 'pass', version: '1.4.2', releaseId: '3f2a9c1' } };
    const { target } = await create();
    expect(target.showVersion).toBe(true);
    expect(target.version).toBeNull();
    const checked = await invoke<HealthTargetDetail>(IPC.health.checkNow, target.id);
    expect(checked.target.version).toBe('1.4.2');
    expect(checked.report?.releaseId).toBe('3f2a9c1');

    const renamed = await invoke<HealthTargetSummary>(IPC.health.update, target.id, {
      name: 'Shop',
    });
    expect(renamed).toMatchObject({ showVersion: true, version: '1.4.2' });
    const hidden = await invoke<HealthTargetSummary>(IPC.health.update, target.id, {
      showVersion: false,
    });
    expect(hidden).toMatchObject({ showVersion: false, version: null });
    const [listed] = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(listed.version).toBeNull();
    await expect(invoke(IPC.health.update, target.id, { showVersion: 'yes' })).rejects.toThrow(
      /showVersion/,
    );
  });

  it('refuses an update that does not hold up, or a target that is gone', async () => {
    const { target } = await create();
    await expect(
      invoke(IPC.health.update, target.id, { url: 'https://u:p@example.com/h' }),
    ).rejects.toThrow(/username or password/);
    await expect(invoke(IPC.health.update, 'missing', { name: 'x' })).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('pauses and resumes a target, which is checked again right after', async () => {
    const { target } = await create();
    await invoke(IPC.health.checkNow, target.id);
    const paused = await invoke<HealthTargetSummary>(IPC.health.setPaused, target.id, true);
    expect(paused).toMatchObject({ paused: true, state: 'paused' });
    const resumed = await invoke<HealthTargetSummary>(IPC.health.setPaused, target.id, false);
    expect(resumed).toMatchObject({ paused: false, state: 'pass', nextCheckAt: null });
  });

  it('removes a target and what it found', async () => {
    const { target } = await create();
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.remove, target.id);
    expect(await invoke(IPC.health.list)).toEqual([]);
    expect(await invoke(IPC.health.get, target.id)).toBeNull();
    const results = JSON.parse(readFileSync(userData.dataFile('health-results.json'), 'utf-8'));
    expect(results).toEqual({});
  });
});

describe('probing and incidents', () => {
  it('checks a target now and returns what it found, sending the key', async () => {
    const { target, secret } = await create();
    const detail = await invoke<HealthTargetDetail>(IPC.health.checkNow, target.id);
    expect(sent).toEqual([`Bearer ${secret.secret}`]);
    expect(detail.target.state).toBe('pass');
    expect(detail.samples).toHaveLength(1);
    expect(detail.target.uptime24h).toBe(1);
    expectNoSecret(detail, secret.secret);
  });

  it('builds the fix prompt from the last report, redacted, and null before one', async () => {
    const { target, secret } = await create();
    expect(await invoke(IPC.health.fixPrompt, target.id)).toBeNull();
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    const prompt = await invoke<string>(IPC.health.fixPrompt, target.id);
    expect(prompt).toContain('postgres:connection');
    expect(prompt).toContain('Environment: Production');
    expect(prompt).not.toContain('hunter2');
    expect(prompt).not.toContain(secret.secret);
  });

  it('analyzes the open incident on request, read-only, and adds it to the fix prompt', async () => {
    const { target } = await create();
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.checkNow, target.id);
    const detail = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
    expect(detail.target.openIncident).not.toBeNull();
    expect(cli.run).not.toHaveBeenCalled();

    await invoke(IPC.health.diagnoseNow, target.id);
    await vi.waitFor(async () => {
      const now = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
      expect(now.incidents[0].diagnosis?.status).toBe('done');
    });
    expect(cli.run).toHaveBeenCalledOnce();
    expect(cli.run.mock.calls[0][2]).toMatchObject({ allowWrites: false });
    expect(await invoke(IPC.health.fixPrompt, target.id)).toContain('the database is down');
  });

  it('runs the analysis on its own when the incident opens on a target that asks for it', async () => {
    const { target } = await create({ autoDiagnose: true });
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.checkNow, target.id);
    await vi.waitFor(() => expect(cli.run).toHaveBeenCalledOnce());
  });

  it('stops a running analysis', async () => {
    const { target } = await create();
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.checkNow, target.id);
    let finish!: (result: HeadlessPromptResult) => void;
    cli.run.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    await invoke(IPC.health.diagnoseNow, target.id);
    await invoke(IPC.health.cancelDiagnose, target.id);
    expect(cli.cancel).toHaveBeenCalledWith(
      (cli.run.mock.calls[0][2] as { requestId: string }).requestId,
    );
    finish({ ok: false, text: '', cliName: 'Claude Code', cancelled: true });
    await vi.waitFor(async () => {
      const now = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
      expect(now.incidents[0].diagnosis?.status).toBe('cancelled');
    });
  });

  it('writes the setup prompt for the endpoint with no secret in it', async () => {
    const { target, secret } = await create();
    const setup = await invoke<HealthSetupPrompt>(IPC.health.setupPrompt, target.id);
    expect(setup.spec).toBe(buildHealthSpecMarkdown());
    expect(setup.prompt).toContain('Add a healthcheck endpoint to Shop');
    expect(setup.prompt).toContain('the Production environment, server web-1');
    expect(setup.prompt).toContain('`/_runova/health`');
    expect(setup.prompt).toContain(HEALTH_ENV.tokenHash);
    expect(setup.prompt).not.toContain(secret.secret);
    expect(setup.prompt).not.toContain(secret.sha256);
  });

  it('suggests the default path when the URL has none', async () => {
    const { target } = await create({ url: endpoint.url });
    const setup = await invoke<HealthSetupPrompt>(IPC.health.setupPrompt, target.id);
    expect(setup.prompt).toContain('`/_runova/health`');
  });
});

describe('arguments', () => {
  it.each([
    ['a number for the URL', { url: 42 }],
    ['a missing name', { name: undefined }],
    ['an unknown auth mode', { authMode: 'digest' }],
    ['a string interval', { intervalSec: '60' }],
    ['a bad server link', { serverLink: { kind: 'ftp', id: 'x' } }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(invoke(IPC.health.create, { ...input(), ...overrides })).rejects.toThrow(
      /healthcheck/i,
    );
  });

  it('refuses ids and flags of the wrong type', async () => {
    await expect(invoke(IPC.health.get, 42)).rejects.toThrow();
    await expect(invoke(IPC.health.remove, '')).rejects.toThrow();
    const { target } = await create();
    await expect(invoke(IPC.health.setPaused, target.id, 'yes')).rejects.toThrow();
    await expect(invoke(IPC.health.list, { projectId: 7 })).rejects.toThrow();
    await expect(invoke(IPC.health.update, target.id, 'nope')).rejects.toThrow();
  });

  it('answers only the windows the guard lets through', async () => {
    const { electronState } = await import('../../test/main/ipcHarness');
    electronState.handlers.clear();
    const { registerHealthHandlers } = await import('./health');
    registerHealthHandlers({ guard: () => false });
    await expect(invoke(IPC.health.list)).rejects.toThrow(/main window/);
  });
});

describe('pruning with projects and environments', () => {
  it('drops the targets of a deleted project', async () => {
    await loadIpc(
      () => import('./projects'),
      (module) => module.registerProjectHandlers(),
    );
    const blog = await create({ projectId: 'p2', environmentId: null });
    const shop = await create();
    await invoke(IPC.projects.delete, 'p2');
    const left = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(left.map((one) => one.id)).toEqual([shop.target.id]);
    expect(await invoke(IPC.health.get, blog.target.id)).toBeNull();
  });

  it('keeps a target whose environment was deleted, without it', async () => {
    await loadIpc(
      () => import('./environments'),
      (module) => module.registerEnvironmentHandlers(),
    );
    const { target } = await create();
    await invoke(IPC.environments.remove, 'e1');
    const [left] = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(left).toMatchObject({ id: target.id, environmentId: null });
  });
});

describe('Runova Cloud (E56), with no account signed in', () => {
  it('says to sign in, and turns nothing online', async () => {
    const { target } = await create();

    const plan = await invoke<{ signedIn: boolean; action: string | null }>(
      IPC.health.cloudPlan,
      target.id,
    );
    expect(plan).toMatchObject({ signedIn: false, action: 'sign-in' });
    await expect(
      invoke(IPC.health.cloudEnable, target.id, {
        consent: false,
        intervalSec: 300,
        notifyInApp: true,
        notifyTelegram: false,
      }),
    ).rejects.toThrow(/Agree to send them/);
    await expect(
      invoke(IPC.health.cloudEnable, target.id, {
        consent: true,
        intervalSec: 300,
        notifyInApp: true,
        notifyTelegram: false,
      }),
    ).rejects.toThrow(/Sign in/);
    await expect(invoke(IPC.health.cloudSettings, target.id, { muted: true })).rejects.toThrow(
      /not on Runova Cloud/,
    );
    const [listed] = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(listed).toMatchObject({ runMode: 'local', cloud: null });
  });

  it('never checks an online monitor here, and turning it back makes it local again', async () => {
    const { target } = await create();
    const stored = JSON.parse(readFileSync(userData.dataFile('health-targets.json'), 'utf-8'));
    stored[0].runMode = 'cloud';
    stored[0].cloudMonitorId = 41;
    userData.writeData('health-targets.json', stored);

    const checked = await invoke<HealthTargetDetail>(IPC.health.checkNow, target.id);

    expect(sent).toEqual([]);
    expect(checked.target).toMatchObject({
      runMode: 'cloud',
      state: 'pending',
      cloud: { signedIn: false },
      headline: expect.stringMatching(/^Sign in/),
    });

    const local = await invoke<HealthTargetSummary>(IPC.health.cloudDisable, target.id);
    expect(local).toMatchObject({ runMode: 'local', cloud: null });
  });

  it('asks about a monitor not saved yet by its project and address', async () => {
    const plan = await invoke<{ signedIn: boolean; action: string | null }>(IPC.health.cloudPlan, {
      projectId: 'p1',
      url: 'https://shop.example.com/_runova/health',
    });
    expect(plan).toMatchObject({ signedIn: false, action: 'sign-in' });
  });

  it('refuses a malformed online setup', async () => {
    const { target } = await create();
    await expect(
      invoke(IPC.health.cloudEnable, target.id, { consent: true, intervalSec: 5 }),
    ).rejects.toThrow(/not valid/);
  });
});

describe('Runova Cloud (E56), signed in', () => {
  const ONLINE = { consent: true, intervalSec: 300, notifyInApp: true, notifyTelegram: false };
  const publicUrl = 'https://shop.example.com/_runova/health';

  function sentTo(method: string, path: string) {
    return account.state.calls.filter((call) => call.method === method && call.path === path);
  }

  async function online() {
    account.state.signedIn = true;
    const { target } = await create({ url: publicUrl });
    const summary = await invoke<HealthTargetSummary>(IPC.health.cloudEnable, target.id, ONLINE);
    return { target, summary };
  }

  it('turns a monitor online with its key, and lists it as online', async () => {
    const { target, summary } = await online();

    expect(summary).toMatchObject({ runMode: 'cloud', cloud: { monitorId: 41, signedIn: true } });
    const [posted] = sentTo('POST', '/cloud-monitors');
    expect(posted.body).toMatchObject({
      itemId: target.id,
      name: 'API',
      projectName: 'Shop',
      environmentName: 'Production',
      url: publicUrl,
      intervalSec: 300,
    });
    const [listed] = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(listed).toMatchObject({ runMode: 'cloud', cloud: { monitorId: 41 } });
  });

  it('sends the server only what changed in the dialog', async () => {
    const { target } = await online();

    await invoke(IPC.health.update, target.id, {
      name: 'Storefront API',
      url: 'https://store.example.com/_runova/health',
      intervalSec: 600,
      timeoutSec: 10,
      allowInsecure: true,
      projectId: 'p2',
      environmentId: null,
    });
    await invoke(IPC.health.update, target.id, { name: 'Store API' });

    expect(sentTo('PATCH', '/cloud-monitors/41').map((call) => call.body)).toEqual([
      {
        name: 'Storefront API',
        url: 'https://store.example.com/_runova/health',
        intervalSec: 600,
        timeoutSec: 10,
        allowInsecure: true,
        environmentName: null,
        projectName: 'Blog',
      },
      { name: 'Store API' },
    ]);
  });

  it('pauses, rotates, mutes and checks on the server instead of here', async () => {
    const { target } = await online();

    await invoke(IPC.health.setPaused, target.id, true);
    const rotated = await invoke<HealthSecretReveal>(IPC.health.rotateSecret, target.id);
    const muted = await invoke<HealthTargetSummary>(IPC.health.cloudSettings, target.id, {
      muted: true,
    });
    const checked = await invoke<HealthTargetDetail>(IPC.health.checkNow, target.id);

    expect(sentTo('PATCH', '/cloud-monitors/41').map((call) => call.body)).toEqual([
      { paused: true },
    ]);
    const keys = sentTo('PUT', '/cloud-monitors/41/secrets/current');
    expect(keys).toHaveLength(1);
    expect(JSON.stringify(keys)).toContain(rotated.secret);
    expect(sentTo('PUT', '/cloud-monitors/41/mutes/me')).toHaveLength(1);
    expect(muted.runMode).toBe('cloud');
    expect(checked.target.runMode).toBe('cloud');
    // This computer sent nothing to the endpoint: the check is the server's.
    expect(sent).toEqual([]);
  });

  it('removes the monitor from the server when it is deleted here', async () => {
    const { target } = await online();

    await invoke(IPC.health.remove, target.id);

    expect(sentTo('DELETE', '/cloud-monitors/41')).toHaveLength(1);
    expect(account.state.monitors.size).toBe(0);
  });

  it('turns it back to this computer', async () => {
    const { target } = await online();

    const local = await invoke<HealthTargetSummary>(IPC.health.cloudDisable, target.id);

    expect(local).toMatchObject({ runMode: 'local', cloud: null });
    expect(account.state.monitors.size).toBe(0);
  });
});
