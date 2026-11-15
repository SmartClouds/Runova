import { MANAGE_METHODS } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  cloudflareOriginMethods,
  type ManageCloudflareOriginDeps,
} from './cloudflareOriginMethods';
import { ManageError } from './session';

/**
 * A server's Cloudflare-only origin for a phone (E102): the origin lock and the Cloudflare Tunnel,
 * through the desktop's own ops and its SSH link, with the same checks as its IPC. A firewall change
 * they make waits to be kept, and the phone can keep or revert it.
 */

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['cloudflare' as const] } };
const ACCOUNT = '01a7362d577a6c3019a474fd6f485823';

const LOCK = {
  enabled: true,
  authenticatedOriginPulls: false,
  state: 'drifted' as const,
  ports: [80, 443],
  missingRules: ['173.245.48.0/20'],
  openRules: [],
  staleRules: [],
  warnings: ['nginx is not managed by Runova.'],
  ranges: { ipv4: ['a', 'b'], ipv6: ['c'], fetchedAtUnixMs: 1000 },
  lastRefreshError: undefined,
};

const TUNNEL = {
  enabled: true,
  state: 'connected' as const,
  sshMode: 'open' as const,
  webPorts: [80, 443],
  sshPorts: [22],
  openRules: [],
  warnings: [],
  connections: 4,
  cloudflaredInstalled: true,
  breakGlassEnabled: false,
  breakGlassDelayMinutes: 30,
  breakGlassOpen: false,
  tunnelName: 'runova-prod',
  sshHostname: 'ssh.example.com',
  cloudflaredVersion: '2026.1.0',
  tunnelId: 'secret-ish-id',
};

const FIREWALL = {
  summary: 'Close 80 and 443',
  commands: ['ufw deny 80/tcp'],
  notes: ['Keeps SSH open.'],
  guard: { blocked: false, reasons: [], checked: [], confirmationPhrase: 'close ssh on prod' },
};

const CHANGE = {
  id: 'cs1',
  state: 'awaitingConfirmation',
  summary: 'Close 80 and 443',
  commands: ['ufw deny 80/tcp'],
  deadlineUnixMs: 99_000,
} as never;

function deps(change: Partial<ManageCloudflareOriginDeps> = {}): ManageCloudflareOriginDeps {
  return {
    access: vi.fn(async () => ({
      state: 'signed-in' as const,
      user: { userName: 'sam', roles: ['Admin', 'Viewer'], twoFactorEnabled: false },
    })),
    firewallPending: vi.fn(async () => CHANGE),
    keep: vi.fn(async () => CHANGE),
    revert: vi.fn(async () => CHANGE),
    lock: {
      originLock: vi.fn(async () => LOCK),
      previewOriginLock: vi.fn(async () => ({
        preview: { changes: [], notes: ['Ranges refresh daily.'], firewall: FIREWALL },
        domains: [
          { domain: 'example.com', zoneId: 'z', zoneName: 'example.com', proxied: true },
          { domain: 'blog.example.com', zoneId: 'z', zoneName: 'example.com', proxied: false },
        ],
      })),
      applyOriginLock: vi.fn(async () => ({
        status: LOCK,
        nginx: { applied: true, problems: [], warnings: [] },
        changeSet: CHANGE,
      })),
    } as never,
    tunnel: {
      status: vi.fn(async () => TUNNEL),
      plan: vi.fn(async () => ({
        status: TUNNEL,
        accounts: [{ cloudflareAccountId: ACCOUNT, label: 'Work', domains: ['example.com'] }],
        domains: [
          {
            domain: 'example.com',
            role: 'site',
            zoneId: 'z',
            zoneName: 'example.com',
            cloudflareAccountId: ACCOUNT,
            routed: false,
          },
          {
            domain: 'old.org',
            role: 'core',
            zoneId: null,
            zoneName: null,
            cloudflareAccountId: null,
            routed: false,
          },
        ],
        coreDomain: { domain: 'old.org', mode: 'direct' },
        ports: { changes: [], notes: [], firewall: FIREWALL },
        suggestedSshHostname: 'ssh-prod.example.com',
        blocker: null,
      })),
      setUp: vi.fn(async () => ({ id: 'job' })),
      route: vi.fn(async () => ({ routed: ['example.com'], skipped: [] })),
      closePorts: vi.fn(async () => ({ status: TUNNEL, changeSet: CHANGE })),
      previewSsh: vi.fn(async () => ({ changes: [], notes: [], firewall: FIREWALL })),
      probeSsh: vi.fn(async () => ({
        ok: true,
        client: '127.0.0.1',
        message: 'SSH gets in through the tunnel.',
      })),
      applySsh: vi.fn(async () => ({ status: TUNNEL, changeSet: CHANGE })),
      previewOff: vi.fn(async () => ({ changes: [], notes: [] })),
      turnOff: vi.fn(async () => ({ status: TUNNEL, changeSet: CHANGE })),
      cleanUp: vi.fn(async () => ({ routed: ['example.com'], skipped: ['the Mesh node'] })),
      joinMesh: vi.fn(async () => ({ id: 'job' })),
      breakGlass: vi.fn(async () => ({ ...TUNNEL, breakGlassEnabled: true })),
    } as never,
    ...change,
  };
}

function call(d: ManageCloudflareOriginDeps, method: string, params?: unknown) {
  return cloudflareOriginMethods(d)[method](params, context);
}

async function failure(promise: unknown): Promise<ManageError> {
  try {
    await promise;
  } catch (error) {
    return error as ManageError;
  }
  throw new Error('expected the call to fail');
}

describe('cloudflare origin methods (E102)', () => {
  it('declares every method under the cloudflare scope, firewall changes as danger', () => {
    for (const name of Object.keys(cloudflareOriginMethods(deps()))) {
      expect(MANAGE_METHODS[name], name).toMatchObject({ scope: 'cloudflare' });
    }
    for (const name of [
      'cloudflare.originLockApply',
      'cloudflare.tunnelClosePorts',
      'cloudflare.tunnelApplySsh',
      'cloudflare.tunnelTurnOff',
      'cloudflare.firewallRevert',
      'cloudflare.tunnelBreakGlass',
    ]) {
      expect(MANAGE_METHODS[name]?.risk, name).toBe('danger');
    }
  });

  it("reads a server's role, lock, tunnel and the change waiting to be kept, in one go", async () => {
    const origin = (await call(deps(), 'cloudflare.origin', { serverId: 'srv-1' })) as Record<
      string,
      unknown
    >;

    expect(origin).toEqual({
      role: 'admin',
      signedIn: true,
      lock: {
        enabled: true,
        authenticatedOriginPulls: false,
        state: 'drifted',
        missingRules: ['173.245.48.0/20'],
        openRules: [],
        staleRules: [],
        warnings: ['nginx is not managed by Runova.'],
        ipv4Ranges: 2,
        ipv6Ranges: 1,
        rangesFetchedAt: 1000,
        lastRefreshError: null,
      },
      lockProblem: null,
      tunnel: {
        enabled: true,
        state: 'connected',
        sshMode: 'open',
        connections: 4,
        tunnelName: 'runova-prod',
        sshHostname: 'ssh.example.com',
        meshAddress: null,
        cloudflaredVersion: '2026.1.0',
        openRules: [],
        warnings: [],
        lastError: null,
        breakGlassEnabled: false,
        breakGlassDelayMinutes: 30,
      },
      tunnelProblem: null,
      pending: {
        id: 'cs1',
        summary: 'Close 80 and 443',
        commands: ['ufw deny 80/tcp'],
        deadline: 99_000,
      },
    });
    expect(JSON.stringify(origin)).not.toContain('secret-ish-id');
  });

  it('says what could not be read, and that a server needs signing in', async () => {
    const d = deps({
      access: vi.fn(async () => ({ state: 'needs-sign-in' as const })),
      lock: {
        originLock: vi.fn(async () => {
          throw new Error('The core is too old for the origin lock.');
        }),
      } as never,
    });
    const origin = (await call(d, 'cloudflare.origin', { serverId: 'srv-1' })) as Record<
      string,
      unknown
    >;
    expect(origin).toMatchObject({
      role: null,
      signedIn: false,
      lock: null,
      lockProblem: 'The core is too old for the origin lock.',
    });
  });

  it('previews the origin lock with each domain in words, then applies it', async () => {
    const d = deps();
    const input = { serverId: 'srv-1', enabled: true, authenticatedOriginPulls: false };
    expect(await call(d, 'cloudflare.originLockPreview', input)).toEqual({
      domains: [
        { domain: 'example.com', text: 'Proxied through Cloudflare', ok: true },
        {
          domain: 'blog.example.com',
          text: 'DNS only: visitors would no longer reach it',
          ok: false,
        },
      ],
      commands: ['ufw deny 80/tcp'],
      notes: ['Ranges refresh daily.', 'Keeps SSH open.'],
      blocked: null,
    });
    expect(await call(d, 'cloudflare.originLockApply', input)).toEqual({
      ok: true,
      message: 'Applied. Keep the firewall change within the time shown, or it rolls back.',
      changeSetId: 'cs1',
    });
    expect(d.lock.applyOriginLock).toHaveBeenCalledWith(input);
  });

  it('says when nginx did not take the lock', async () => {
    const d = deps({
      lock: {
        applyOriginLock: vi.fn(async () => ({
          status: LOCK,
          nginx: { applied: false, problems: [], warnings: [], error: 'nginx -t failed' },
        })),
      } as never,
    });
    expect(
      await call(d, 'cloudflare.originLockApply', {
        serverId: 'srv-1',
        enabled: false,
        authenticatedOriginPulls: false,
      }),
    ).toEqual({
      ok: true,
      message: 'The firewall changed, but nginx did not take it: nginx -t failed.',
      changeSetId: null,
    });
  });

  it('plans the tunnel with what each name would do', async () => {
    const plan = (await call(deps(), 'cloudflare.tunnelPlan', { serverId: 'srv-1' })) as Record<
      string,
      unknown
    >;
    expect(plan).toEqual({
      accounts: [{ id: ACCOUNT, label: 'Work' }],
      domains: [
        {
          domain: 'example.com',
          role: 'site',
          cloudflareAccountId: ACCOUNT,
          routed: false,
          inAccount: true,
        },
        {
          domain: 'old.org',
          role: 'core',
          cloudflareAccountId: null,
          routed: false,
          inAccount: false,
        },
      ],
      coreDirect: 'old.org',
      commands: ['ufw deny 80/tcp'],
      notes: ['Keeps SSH open.'],
      blocked: null,
      suggestedSshHostname: 'ssh-prod.example.com',
      blocker: null,
    });
  });

  it('runs every tunnel step through the desktop with checked input', async () => {
    const d = deps();
    await call(d, 'cloudflare.tunnelSetUp', {
      serverId: 'srv-1',
      cloudflareAccountId: ACCOUNT,
      sshHostname: 'SSH.example.com',
    });
    expect(await call(d, 'cloudflare.tunnelRoute', { serverId: 'srv-1' })).toEqual({
      routed: ['example.com'],
      skipped: [],
    });
    expect(await call(d, 'cloudflare.tunnelClosePorts', { serverId: 'srv-1' })).toMatchObject({
      changeSetId: 'cs1',
    });
    expect(
      await call(d, 'cloudflare.tunnelPreviewSsh', { serverId: 'srv-1', mode: 'closed' }),
    ).toEqual({
      commands: ['ufw deny 80/tcp'],
      notes: ['Keeps SSH open.'],
      blocked: null,
      confirmationPhrase: 'close ssh on prod',
    });
    expect(
      await call(d, 'cloudflare.tunnelProbeSsh', { serverId: 'srv-1', route: 'cloudflare' }),
    ).toEqual({ ok: true, message: 'SSH gets in through the tunnel.' });
    await call(d, 'cloudflare.tunnelApplySsh', {
      serverId: 'srv-1',
      mode: 'closed',
      overrideConfirmation: 'close ssh on prod',
      password: 'hunter2',
    });
    await call(d, 'cloudflare.tunnelPreviewOff', { serverId: 'srv-1', reopenWeb: true });
    await call(d, 'cloudflare.tunnelTurnOff', { serverId: 'srv-1', reopenWeb: false });
    expect(
      await call(d, 'cloudflare.tunnelCleanUp', { serverId: 'srv-1', pointBack: true }),
    ).toEqual({
      ok: true,
      message: 'The tunnel is off. Left as they were: the Mesh node.',
    });
    await call(d, 'cloudflare.tunnelJoinMesh', { serverId: 'srv-1' });
    await call(d, 'cloudflare.tunnelBreakGlass', {
      serverId: 'srv-1',
      enabled: true,
      delayMinutes: 60,
    });

    expect(d.tunnel.setUp).toHaveBeenCalledWith({
      serverId: 'srv-1',
      cloudflareAccountId: ACCOUNT,
      sshHostname: 'ssh.example.com',
    });
    expect(d.tunnel.applySsh).toHaveBeenCalledWith({
      serverId: 'srv-1',
      mode: 'closed',
      overrideConfirmation: 'close ssh on prod',
      password: 'hunter2',
    });
    expect(d.tunnel.turnOff).toHaveBeenCalledWith({ serverId: 'srv-1', reopenWeb: false });
    expect(d.tunnel.cleanUp).toHaveBeenCalledWith('srv-1', true);
    expect(d.tunnel.breakGlass).toHaveBeenCalledWith({
      serverId: 'srv-1',
      enabled: true,
      delayMinutes: 60,
    });
  });

  it('keeps or reverts the change waiting, and says which', async () => {
    const d = deps();
    const keep = { serverId: 'srv-1', changeSetId: 'cs1' };
    expect(await call(d, 'cloudflare.firewallKeep', keep)).toEqual({
      ok: true,
      message: 'Firewall change kept.',
    });
    expect(await call(d, 'cloudflare.firewallRevert', keep)).toEqual({
      ok: true,
      message: 'Firewall change reverted. The old rules are back.',
    });
    expect(d.keep).toHaveBeenCalledWith(keep);
  });

  it('refuses input the desktop would refuse', async () => {
    const d = deps();
    for (const attempt of [
      call(d, 'cloudflare.origin', { serverId: '../x' }),
      call(d, 'cloudflare.tunnelApplySsh', { serverId: 'srv-1', mode: 'everyone' }),
      call(d, 'cloudflare.tunnelSetUp', { serverId: 'srv-1', cloudflareAccountId: 'nope' }),
      call(d, 'cloudflare.tunnelBreakGlass', { serverId: 'srv-1', enabled: true, delayMinutes: 1 }),
      call(d, 'cloudflare.tunnelProbeSsh', { serverId: 'srv-1', route: 'direct' }),
      call(d, 'cloudflare.firewallKeep', { serverId: 'srv-1' }),
    ]) {
      const error = await failure(attempt);
      expect(error).toBeInstanceOf(ManageError);
      expect(error.code).toBe('bad-params');
    }
    expect(d.tunnel.applySsh).not.toHaveBeenCalled();
  });
});
