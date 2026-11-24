import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import { cloudflareErrorCode, cloudflareErrorPermission } from '../../../shared/cloudflareErrors';
import type { EmailGateInput } from '../../../shared/cloudflareTypes';
import type { SiteSettings } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import { CoreLinks } from '../live/coreLinks';
import { fakeLiveHubs } from '../testing/fakeLiveHub';
import { CloudflareEmailGateOps } from './emailGate';
import { CloudflareState } from './state';
import { ALL_GRANTS, type FakeToken } from './testing/fakeCloudflare';
import { connectedService, memoryPort } from './testing/harness';
import { CF_ACCOUNT_ID, dnsRecord, ZONE_ID } from './testing/recorded';

/**
 * E96 from the main process: the email code gate is Cloudflare Access in front of a hostname, with
 * the One-time PIN login and a policy listing who may ask for a code. Cloudflare holds the truth,
 * so the Access tab is read from it every time. Applications made elsewhere are shown and never
 * touched, the certificate challenge path stays open for renewals, and on the core domain this
 * computer gets its own pass (an Access service token, sealed here) so the app keeps reaching the
 * core.
 */

let links: CoreLinks | null = null;

afterEach(() => {
  links?.closeAll();
  links = null;
});

const TEAM = 'acme.cloudflareaccess.com';
const OTP = {
  id: '0b2c3d4e-0000-4000-8000-000000000001',
  name: 'One-time PIN',
  type: 'onetimepin',
};

function site(id: string, domains: string[]): SiteSettings {
  return {
    id,
    domains,
    upstream: {
      kind: 'servicePort',
      service: 'web',
      port: 3000,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: false,
    gzip: false,
    http2: true,
    redirectToHttps: true,
  };
}

function record(id: string, name: string, proxied: boolean, type = 'A') {
  return {
    ...dnsRecord,
    id: id.repeat(32),
    type,
    name,
    content: type === 'CNAME' ? 'elsewhere.example.net' : '203.0.113.10',
    proxied,
  };
}

async function setup(
  options: {
    grants?: FakeToken['grants'];
    zeroTrust?: 'ready' | 'no-otp' | 'none';
    coreDown?: boolean;
    /** The server's link is not up, so its core is not asked at all. */
    offline?: boolean;
    /** How the server can be reached from outside. Locked to Cloudflare with AOP unless said. */
    origin?: 'locked' | 'locked-no-aop' | 'tunnel' | 'open';
  } = {},
) {
  const core = new FakeCore(() => Date.now());
  const origin = options.origin ?? 'locked';
  const lock = core.cloudflare.status();
  vi.spyOn(core.cloudflare, 'status').mockReturnValue({
    ...lock,
    enabled: origin.startsWith('locked'),
    authenticatedOriginPulls: origin === 'locked',
    state: origin.startsWith('locked') ? 'on' : 'off',
  });
  const tunnel = core.tunnel.status();
  vi.spyOn(core.tunnel, 'status').mockReturnValue({
    ...tunnel,
    enabled: origin === 'tunnel',
    state: origin === 'tunnel' ? 'connected' : 'off',
  });
  core.nginx.status = { ...core.nginx.status, managed: true };
  core.nginx.saveSite(site('blog', ['blog.example.com']));
  core.coreDomain = {
    ...core.coreDomain,
    enabled: true,
    domain: 'core.example.com',
    mode: 'cloudflare',
  };
  const hubs = fakeLiveHubs(core);
  links = new CoreLinks({ open: () => hubs.open() });
  const zeroTrust = options.zeroTrust ?? 'ready';
  const harness = await connectedService({
    token: { grants: options.grants ?? { ...ALL_GRANTS, access: 'edit', accessLogin: 'edit' } },
    zeroTrust:
      zeroTrust === 'none'
        ? {}
        : {
            [CF_ACCOUNT_ID]: {
              teamDomain: TEAM,
              identityProviders: zeroTrust === 'ready' ? [OTP] : [],
            },
          },
    zones: [
      {
        id: ZONE_ID,
        name: 'example.com',
        records: [
          record('a', 'blog.example.com', true),
          record('b', 'blog.example.com', true, 'AAAA'),
          record('c', 'core.example.com', true),
          record('d', 'shop.example.com', false),
          record('e', 'mail.example.com', false, 'MX'),
          record('f', '*.example.com', true),
          record('9', 'wiki.example.com', true, 'CNAME'),
        ],
      },
    ],
  });
  const passes = new CloudflareState(memoryPort());
  const calls: string[] = [];
  const ops = new CloudflareEmailGateOps({
    cloudflare: harness.service,
    passes,
    seal: async (plaintext): Promise<SecretEnvelope> => ({
      mode: 'safeStorage',
      ciphertext: `sealed:${plaintext}`,
    }),
    servers: async () => [
      { id: 'srv-1', name: 'prod', online: !options.offline, coreDomain: 'core.example.com' },
    ],
    links: {
      call: (serverId, work) => {
        calls.push(serverId);
        return options.coreDown
          ? Promise.reject(new Error('core is down'))
          : links!.call(serverId, work);
      },
    },
    computerName: () => 'studio-pc',
    coreTimeoutMs: 2_000,
  });
  return { ops, core, passes, calls, ...harness };
}

const INPUT: EmailGateInput = {
  zoneId: ZONE_ID,
  hostname: 'blog.example.com',
  emails: ['ana@example.com'],
  emailDomains: ['company.com'],
  session: '24h',
};

describe('CloudflareEmailGateOps.plan', () => {
  it("lists the zone's names with what each is to the app, the core domain first", async () => {
    const { ops } = await setup();

    const plan = await ops.plan(ZONE_ID);

    expect(plan.cloudflareAccountId).toBe(CF_ACCOUNT_ID);
    expect(plan.readiness).toEqual({ organization: true, teamDomain: TEAM, oneTimePin: true });
    expect(plan.hosts.map((host) => [host.hostname, host.role, host.proxied])).toEqual([
      ['core.example.com', 'core', true],
      ['blog.example.com', 'site', true],
      ['shop.example.com', 'other', false],
      ['wiki.example.com', 'other', true],
    ]);
    expect(plan.hosts[0]).toMatchObject({
      serverId: 'srv-1',
      serverName: 'prod',
      gate: { kind: 'off' },
      thisComputerPass: false,
    });
    expect(plan.hosts[1]).toMatchObject({ siteName: 'blog', recordId: 'a'.repeat(32) });
  });

  it('still lists the names when a core does not answer, knowing the core domain from here', async () => {
    const { ops } = await setup({ coreDown: true });

    const plan = await ops.plan(ZONE_ID);

    expect(plan.hosts.map((host) => [host.hostname, host.role])).toEqual([
      ['core.example.com', 'core'],
      ['blog.example.com', 'other'],
      ['shop.example.com', 'other'],
      ['wiki.example.com', 'other'],
    ]);
  });

  it('never asks the core of a server whose link is not up, yet still passes its core domain', async () => {
    const { ops, calls, passes } = await setup({ offline: true });

    await ops.plan(ZONE_ID);
    expect(calls).toEqual([]);

    // Putting a gate on is the one time it asks, to check only Cloudflare can reach the server.
    await ops.save({ ...INPUT, hostname: 'core.example.com' });

    expect(calls).toEqual(['srv-1']);
    expect(await passes.pass('core.example.com')).not.toBeNull();
  });

  it('says when Zero Trust or the One-time PIN login is not set up yet', async () => {
    expect((await (await setup({ zeroTrust: 'none' })).ops.plan(ZONE_ID)).readiness).toEqual({
      organization: false,
      teamDomain: null,
      oneTimePin: false,
    });
    expect((await (await setup({ zeroTrust: 'no-otp' })).ops.plan(ZONE_ID)).readiness).toEqual({
      organization: true,
      teamDomain: TEAM,
      oneTimePin: false,
    });
  });

  it('shows an Access application made elsewhere as such, and leaves it alone', async () => {
    const { ops, fake } = await setup();
    fake.accessApps.set('11111111-1111-4111-8111-111111111111', {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Team wiki',
      domain: 'wiki.example.com',
      type: 'self_hosted',
    });

    const plan = await ops.plan(ZONE_ID);

    expect(plan.hosts.find((host) => host.hostname === 'wiki.example.com')?.gate).toEqual({
      kind: 'elsewhere',
      appId: '11111111-1111-4111-8111-111111111111',
      name: 'Team wiki',
    });
    await expect(ops.save({ ...INPUT, hostname: 'wiki.example.com' })).rejects.toThrow(/Team wiki/);
    expect(fake.accessApps.size).toBe(1);
  });

  it('names the permission a refusal is about, for the guided fix', async () => {
    const { ops } = await setup({ grants: { ...ALL_GRANTS, access: 'edit' } });

    const error = await ops.plan(ZONE_ID).catch((caught: unknown) => caught);

    expect(cloudflareErrorCode(error)).toBe('missing-permission');
    expect(cloudflareErrorPermission(error)).toBe('accessLogin');
  });
});

describe('CloudflareEmailGateOps.find', () => {
  it('finds the zone and the gate of one name, for the shortcuts on other pages', async () => {
    const { ops } = await setup();
    await ops.save(INPUT);

    const found = await ops.find('Blog.Example.com');

    expect(found?.zone).toMatchObject({ id: ZONE_ID, name: 'example.com' });
    expect(found?.readiness.oneTimePin).toBe(true);
    expect(found?.host).toMatchObject({ hostname: 'blog.example.com', role: 'site' });
    expect(found?.host.gate.kind).toBe('on');
  });

  it('says nothing for a name in no connected zone, or with no Cloudflare connected', async () => {
    const { ops, service } = await setup();

    expect(await ops.find('blog.example.org')).toBeNull();
    await service.removeToken('acct-1');
    expect(await ops.find('blog.example.com')).toBeNull();
  });
});

describe('CloudflareEmailGateOps.prepare', () => {
  it('turns on the One-time PIN login when Zero Trust is there without it', async () => {
    const { ops, fake } = await setup({ zeroTrust: 'no-otp' });

    const readiness = await ops.prepare({ zoneId: ZONE_ID });

    expect(readiness).toEqual({ organization: true, teamDomain: TEAM, oneTimePin: true });
    expect(fake.identityProviders.get(CF_ACCOUNT_ID)).toEqual([
      expect.objectContaining({ type: 'onetimepin', name: 'One-time PIN' }),
    ]);
    await ops.prepare({ zoneId: ZONE_ID });
    expect(fake.identityProviders.get(CF_ACCOUNT_ID)).toHaveLength(1);
  });

  it('sets Zero Trust up with the team name given, then the login', async () => {
    const { ops, fake } = await setup({ zeroTrust: 'none' });

    await expect(ops.prepare({ zoneId: ZONE_ID })).rejects.toThrow(/team name/i);
    await expect(ops.prepare({ zoneId: ZONE_ID, teamName: 'Bad Name' })).rejects.toThrow(
      /lower case/i,
    );
    const readiness = await ops.prepare({ zoneId: ZONE_ID, teamName: 'acme-ops' });

    expect(readiness).toEqual({
      organization: true,
      teamDomain: 'acme-ops.cloudflareaccess.com',
      oneTimePin: true,
    });
    expect(fake.organizations.get(CF_ACCOUNT_ID)).toMatchObject({
      auth_domain: 'acme-ops.cloudflareaccess.com',
    });
  });

  it('says in words when the team name is taken', async () => {
    const { ops } = await setup({ zeroTrust: 'none' });

    await expect(ops.prepare({ zoneId: ZONE_ID, teamName: 'taken-acme' })).rejects.toThrow(
      /taken-acme.*another/i,
    );
  });
});

describe('CloudflareEmailGateOps.save and remove', () => {
  it('puts the gate on a name with the One-time PIN login and the people listed', async () => {
    const { ops, fake } = await setup();

    const state = await ops.save(INPUT);

    const apps = [...fake.accessApps.values()];
    const gate = apps.find((app) => app.domain === 'blog.example.com');
    expect(gate).toMatchObject({
      name: 'Runova, blog.example.com',
      type: 'self_hosted',
      session_duration: '24h',
      allowed_idps: [OTP.id],
      auto_redirect_to_identity: true,
      app_launcher_visible: false,
    });
    expect(gate?.policies).toEqual([
      expect.objectContaining({
        decision: 'allow',
        include: [
          { email: { email: 'ana@example.com' } },
          { email_domain: { domain: 'company.com' } },
        ],
      }),
    ]);
    expect(state).toEqual({
      kind: 'on',
      appId: gate?.id,
      emails: ['ana@example.com'],
      emailDomains: ['company.com'],
      session: '24h',
    });
    const plan = await ops.plan(ZONE_ID);
    expect(plan.hosts.find((host) => host.hostname === 'blog.example.com')?.gate).toEqual(state);
  });

  it('keeps the certificate challenge path open, so renewals still work', async () => {
    const { ops, fake } = await setup();

    await ops.save(INPUT);

    const bypass = [...fake.accessApps.values()].find(
      (app) => app.domain === 'blog.example.com/.well-known/acme-challenge',
    );
    expect(bypass).toMatchObject({ type: 'self_hosted' });
    expect(bypass?.policies).toEqual([
      expect.objectContaining({ decision: 'bypass', include: [{ everyone: {} }] }),
    ]);
  });

  it('changes who gets in and for how long in place', async () => {
    const { ops, fake } = await setup();
    const first = await ops.save(INPUT);

    const second = await ops.save({
      ...INPUT,
      emails: ['bo@example.com', 'cy@example.com'],
      emailDomains: [],
      session: '30m',
    });

    expect(second).toMatchObject({ kind: 'on', session: '30m' });
    expect(second.kind === 'on' && second.appId).toBe(first.kind === 'on' && first.appId);
    expect(fake.accessApps.size).toBe(2);
    const gate = fake.accessApps.get(second.kind === 'on' ? second.appId : '');
    expect(gate?.session_duration).toBe('30m');
    expect(gate?.policies).toEqual([
      expect.objectContaining({
        decision: 'allow',
        include: [{ email: { email: 'bo@example.com' } }, { email: { email: 'cy@example.com' } }],
      }),
    ]);
  });

  it('refuses what the dialog would refuse, and a name without the proxy', async () => {
    const { ops, fake } = await setup();

    await expect(ops.save({ ...INPUT, emails: [], emailDomains: [] })).rejects.toThrow(
      /at least one/i,
    );
    await expect(ops.save({ ...INPUT, hostname: 'blog.other.io' })).rejects.toThrow(
      /not in example\.com/,
    );
    await expect(ops.save({ ...INPUT, hostname: 'shop.example.com' })).rejects.toThrow(/proxy/i);
    expect(fake.accessApps.size).toBe(0);
  });

  // Access runs at Cloudflare's edge, so a server that answers anyone on 80 and 443 hands the
  // gated name to whoever asks it directly at its address.
  it('refuses a name on a server that still answers anyone, and makes no gate', async () => {
    const { ops, fake } = await setup({ origin: 'open' });

    await expect(ops.save(INPUT)).rejects.toThrow(
      'prod still answers anyone who finds its address',
    );
    await expect(ops.save({ ...INPUT, hostname: 'core.example.com' })).rejects.toThrow(
      'prod still answers anyone who finds its address',
    );
    expect(fake.accessApps.size).toBe(0);
  });

  it('refuses a server locked to Cloudflare without Authenticated Origin Pulls', async () => {
    const { ops, fake } = await setup({ origin: 'locked-no-aop' });

    await expect(ops.save(INPUT)).rejects.toThrow('Authenticated Origin Pulls');
    expect(fake.accessApps.size).toBe(0);
  });

  it('puts the gate on a server behind a tunnel with its web ports closed', async () => {
    const { ops } = await setup({ origin: 'tunnel' });

    await expect(ops.save(INPUT)).resolves.toMatchObject({ kind: 'on' });
  });

  it('refuses when the server cannot say how it is reached', async () => {
    const { ops, fake } = await setup({ coreDown: true });

    await expect(ops.save({ ...INPUT, hostname: 'core.example.com' })).rejects.toThrow(
      'could not ask prod whether only Cloudflare can reach it',
    );
    expect(fake.accessApps.size).toBe(0);
  });

  it('still gates a name no saved server serves', async () => {
    const { ops } = await setup({ origin: 'open' });

    await expect(ops.save({ ...INPUT, hostname: 'wiki.example.com' })).resolves.toMatchObject({
      kind: 'on',
    });
  });

  it('asks for the one-time setup first when the login is not on', async () => {
    const { ops, fake } = await setup({ zeroTrust: 'no-otp' });

    await expect(ops.save(INPUT)).rejects.toThrow(/turn on email codes/i);
    expect(fake.accessApps.size).toBe(0);
  });

  it('takes the gate and its challenge path off again', async () => {
    const { ops, fake } = await setup();
    await ops.save(INPUT);

    await ops.remove({ zoneId: ZONE_ID, hostname: 'blog.example.com' });

    expect(fake.accessApps.size).toBe(0);
    const plan = await ops.plan(ZONE_ID);
    expect(plan.hosts.find((host) => host.hostname === 'blog.example.com')?.gate).toEqual({
      kind: 'off',
    });
    await ops.remove({ zoneId: ZONE_ID, hostname: 'blog.example.com' });
  });

  it('puts the proxy on for a name so the gate can go on it', async () => {
    const { ops, fake } = await setup();

    await ops.proxy({ zoneId: ZONE_ID, hostname: 'shop.example.com' });

    const shop = fake.zones.get(ZONE_ID)?.records.filter((r) => r.name === 'shop.example.com');
    expect(shop?.every((r) => r.proxied === true)).toBe(true);
  });
});

describe('the pass through the gate on the core domain', () => {
  it('gives this computer a pass when the gate goes on the core domain', async () => {
    const { ops, fake, passes } = await setup();

    const state = await ops.save({ ...INPUT, hostname: 'core.example.com' });

    const appId = state.kind === 'on' ? state.appId : '';
    const policies = (fake.accessApps.get(appId)?.policies ?? []) as Record<string, unknown>[];
    const pass = await passes.pass('core.example.com');
    const token = fake.serviceTokens.get(pass?.serviceTokenId ?? '');
    expect(token?.name).toBe('Runova app on studio-pc, core.example.com');
    expect(policies.map((policy) => policy.decision).sort()).toEqual(['allow', 'non_identity']);
    expect(policies.find((policy) => policy.decision === 'non_identity')?.include).toEqual([
      { service_token: { token_id: pass?.serviceTokenId } },
    ]);
    expect(pass).toMatchObject({
      appId,
      clientId: token?.client_id,
      clientSecret: { mode: 'safeStorage', ciphertext: `sealed:${token?.client_secret}` },
    });
    const host = (await ops.plan(ZONE_ID)).hosts.find((h) => h.hostname === 'core.example.com');
    expect(host?.thisComputerPass).toBe(true);
    expect(JSON.stringify(state)).not.toContain(String(token?.client_secret));
    expect(JSON.stringify(await ops.plan(ZONE_ID))).not.toContain(String(token?.client_secret));
  });

  it('keeps the pass when only the people change', async () => {
    const { ops, fake, passes } = await setup();
    await ops.save({ ...INPUT, hostname: 'core.example.com' });
    const before = await passes.pass('core.example.com');

    await ops.save({ ...INPUT, hostname: 'core.example.com', emails: ['bo@example.com'] });

    expect(await passes.pass('core.example.com')).toEqual(before);
    expect(fake.serviceTokens.size).toBe(1);
  });

  it('lets another computer through with a pass of its own', async () => {
    const { ops, fake, passes } = await setup();
    await ops.save({ ...INPUT, hostname: 'core.example.com' });
    await passes.removePass('core.example.com');

    await ops.letThisComputerThrough({ zoneId: ZONE_ID, hostname: 'core.example.com' });

    expect(fake.serviceTokens.size).toBe(2);
    const host = (await ops.plan(ZONE_ID)).hosts.find((h) => h.hostname === 'core.example.com');
    expect(host?.thisComputerPass).toBe(true);
    await expect(
      ops.letThisComputerThrough({ zoneId: ZONE_ID, hostname: 'blog.example.com' }),
    ).rejects.toThrow(/no email code gate/i);
  });

  it('removes every pass, here and at Cloudflare, when the gate comes off', async () => {
    const { ops, fake, passes } = await setup();
    await ops.save({ ...INPUT, hostname: 'core.example.com' });
    await passes.removePass('core.example.com');
    await ops.letThisComputerThrough({ zoneId: ZONE_ID, hostname: 'core.example.com' });

    await ops.remove({ zoneId: ZONE_ID, hostname: 'core.example.com' });

    expect(fake.serviceTokens.size).toBe(0);
    expect(fake.accessApps.size).toBe(0);
    expect(await passes.pass('core.example.com')).toBeNull();
  });
});
