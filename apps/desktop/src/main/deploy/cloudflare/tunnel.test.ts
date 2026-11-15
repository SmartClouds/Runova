import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SshRoute, StoredTunnelSsh } from '../../../shared/apiTypes';
import { cloudflareErrorCode, cloudflareErrorPermission } from '../../../shared/cloudflareErrors';
import type { SiteSettings } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import {
  FAKE_TUNNEL_PORT,
  tunnelIdOf,
} from '../../../shared/deploy/testing/fakeCloudflareTunnelCore';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import { CoreLinks } from '../live/coreLinks';
import { fakeLiveHubs } from '../testing/fakeLiveHub';
import { ALL_GRANTS, type FakeToken } from './testing/fakeCloudflare';
import { connectedService, TOKEN } from './testing/harness';
import { CF_ACCOUNT_ID, dnsRecord, OTHER_ZONE_ID, ZONE_ID } from './testing/recorded';
import { CloudflareTunnelOps, planTunnelRecords, tunnelTarget } from './tunnel';

/**
 * E95 from the main process: the tunnel made at Cloudflare with the account token (which never
 * reaches the core, only the tunnel's own token does), its names routed as proxied CNAMEs,
 * Cloudflare Access in front of SSH with a sealed service token, SSH limited over the way in
 * that remains, and everything put back when the tunnel goes.
 */

let links: CoreLinks | null = null;

afterEach(() => {
  links?.closeAll();
  links = null;
});

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

const PUBLIC_SSH = '203.0.113.50 50123 192.0.2.10 22';

async function setup(
  options: { grants?: FakeToken['grants']; probe?: (route: SshRoute) => Promise<string> } = {},
) {
  const core = new FakeCore(() => Date.now());
  core.nginx.status = { ...core.nginx.status, managed: true };
  core.nginx.saveSite(site('blog', ['blog.example.com', 'www.example.com', 'shop.example.net']));
  const hubs = fakeLiveHubs(core);
  links = new CoreLinks({ open: () => hubs.open() });
  const harness = await connectedService({
    token: {
      grants: options.grants ?? { ...ALL_GRANTS, tunnel: 'edit', access: 'edit', mesh: 'edit' },
    },
    zones: [
      {
        id: ZONE_ID,
        name: 'example.com',
        records: [
          {
            ...dnsRecord,
            id: 'a'.repeat(32),
            type: 'A',
            name: 'blog.example.com',
            content: '203.0.113.10',
            proxied: true,
          },
          {
            ...dnsRecord,
            id: 'b'.repeat(32),
            type: 'AAAA',
            name: 'blog.example.com',
            content: '2001:db8::10',
            proxied: true,
          },
          {
            ...dnsRecord,
            id: 'c'.repeat(32),
            type: 'A',
            name: 'www.example.com',
            content: '203.0.113.10',
            proxied: false,
          },
        ],
      },
      { id: OTHER_ZONE_ID, name: 'example.org' },
    ],
  });
  let kept: StoredTunnelSsh = {};
  let route: SshRoute | undefined;
  const reset = vi.fn();
  const sshConnection = { value: PUBLIC_SSH };
  const ops = new CloudflareTunnelOps({
    cloudflare: harness.service,
    links,
    roles: () => core.roles,
    onLinkConnection: (_serverId, work) => work(sshConnection.value),
    serverName: async () => 'prod',
    addresses: async () => ({ ipv4: ['203.0.113.10'], ipv6: [] }),
    tunnelSsh: {
      read: async () => kept,
      update: async (_serverId, change, next) => {
        kept = change(kept) ?? {};
        if (next !== undefined) route = next ?? undefined;
      },
      seal: async (plaintext) => ({ mode: 'safeStorage', ciphertext: `sealed:${plaintext}` }),
    },
    probeSsh: async (_serverId, which) => (options.probe ? options.probe(which) : PUBLIC_SSH),
    resetSsh: reset,
    withCoreDomainHub: async (serverId, work) => {
      core.overCoreDomain = true;
      try {
        return await links!.call(serverId, work);
      } finally {
        core.overCoreDomain = false;
      }
    },
  });
  return {
    core,
    ops,
    reset,
    sshConnection,
    kept: () => kept,
    route: () => route,
    ...harness,
  };
}

function records(fake: Awaited<ReturnType<typeof setup>>['fake'], name: string) {
  return (fake.zones.get(ZONE_ID)?.records ?? []).filter((record) => record.name === name);
}

async function confirm(core: FakeCore, changeSetId: string) {
  const fresh = core.connect();
  await fresh.confirmFirewallChanges(changeSetId);
}

describe('planTunnelRecords', () => {
  it('replaces address records with one proxied CNAME and changes nothing the second time', () => {
    const target = tunnelTarget('6ff42ae2-765d-4adf-8112-31c55c1551ef');
    const before = [
      {
        ...dnsRecord,
        id: '1',
        type: 'A',
        name: 'a.example.com',
        content: '203.0.113.1',
        proxied: true,
      },
      {
        ...dnsRecord,
        id: '2',
        type: 'CNAME',
        name: 'b.example.com',
        content: 'elsewhere.example.net',
        proxied: false,
      },
    ] as never;

    const plan = planTunnelRecords(['a.example.com', 'b.example.com'], target, before);
    const again = planTunnelRecords(['a.example.com'], target, [
      {
        ...dnsRecord,
        id: '3',
        type: 'CNAME',
        name: 'a.example.com',
        content: target,
        proxied: true,
      },
    ] as never);

    expect(plan.deletes.map((record) => record.id)).toEqual(['1']);
    expect(plan.patches.map((record) => record.id)).toEqual(['2']);
    expect(plan.posts).toEqual(['a.example.com']);
    expect(again).toEqual({ deletes: [], patches: [], posts: [] });
  });
});

describe('CloudflareTunnelOps', () => {
  it('plans in the account that holds the server, naming what it cannot route', async () => {
    const { ops } = await setup();

    const plan = await ops.plan('srv-1');

    expect(plan.accounts[0]?.cloudflareAccountId).toBe(CF_ACCOUNT_ID);
    expect(plan.accounts[0]?.domains.sort()).toEqual(['blog.example.com', 'www.example.com']);
    expect(plan.domains.find((domain) => domain.domain === 'shop.example.net')?.zoneId).toBeNull();
    expect(plan.suggestedSshHostname).toBe('ssh-prod.example.com');
    expect(plan.blocker).toBeNull();
    expect(plan.ports.changes).toHaveLength(2);
    expect(plan.status.state).toBe('off');
  });

  it('makes the tunnel at Cloudflare and hands the core only the tunnel token', async () => {
    const { ops, core, fake } = await setup();

    const job = await ops.setUp({
      serverId: 'srv-1',
      cloudflareAccountId: CF_ACCOUNT_ID,
      sshHostname: 'ssh-prod.example.com',
    });
    const [tunnel] = [...fake.tunnels.values()];

    expect(job.state).toBe('succeeded');
    expect(tunnel?.name).toBe('runova-prod');
    expect(tunnel?.configSrc).toBe('cloudflare');
    expect(core.tunnel.token && tunnelIdOf(core.tunnel.token)).toBe(tunnel?.id);
    expect(core.tunnel.token).not.toContain(TOKEN);
    expect((await ops.status('srv-1')).state).toBe('portsOpen');
  });

  it('makes nothing at Cloudflare while nginx is not set up for Runova', async () => {
    const { ops, core, fake } = await setup();
    core.nginx.status = { ...core.nginx.status, managed: false };

    const plan = await ops.plan('srv-1');
    const failure = await ops
      .setUp({ serverId: 'srv-1', cloudflareAccountId: CF_ACCOUNT_ID, sshHostname: null })
      .catch((error: unknown) => error as Error);

    expect(plan.blocker).toMatch(/not set up for Runova/);
    expect((failure as Error).message).toMatch(/not set up for Runova/);
    expect(fake.tunnels.size).toBe(0);
  });

  it('takes the server its own tunnel again rather than making a second one', async () => {
    const { ops, fake } = await setup();
    const input = { serverId: 'srv-1', cloudflareAccountId: CF_ACCOUNT_ID, sshHostname: null };

    await ops.setUp(input);
    await ops.setUp(input);

    expect(fake.tunnels.size).toBe(1);
  });

  it('routes every name in the account to the tunnel and puts Access in front of SSH', async () => {
    const { ops, fake, kept } = await setup();
    await ops.setUp({
      serverId: 'srv-1',
      cloudflareAccountId: CF_ACCOUNT_ID,
      sshHostname: 'ssh-prod.example.com',
    });
    const tunnel = [...fake.tunnels.values()][0];
    const target = tunnelTarget(tunnel?.id ?? '');

    const result = await ops.route('srv-1');
    const writes = fake.writes().length;
    const again = await ops.route('srv-1');

    expect(result.routed.sort()).toEqual([
      'blog.example.com',
      'ssh-prod.example.com',
      'www.example.com',
    ]);
    expect(result.skipped).toEqual(['shop.example.net']);
    expect(tunnel?.config).toEqual({
      ingress: [
        { hostname: 'ssh-prod.example.com', service: 'ssh://localhost:22' },
        { service: `http://127.0.0.2:${FAKE_TUNNEL_PORT}` },
      ],
    });
    for (const name of ['blog.example.com', 'www.example.com', 'ssh-prod.example.com']) {
      expect(
        records(fake, name).map((record) => [record.type, record.content, record.proxied]),
      ).toEqual([['CNAME', target, true]]);
    }
    const app = [...fake.accessApps.values()][0];
    expect(app?.domain).toBe('ssh-prod.example.com');
    const serviceToken = [...fake.serviceTokens.values()][0];
    const policies = (app?.policies ?? []) as Array<{ include: unknown }>;
    expect(policies[0]?.include).toEqual([{ service_token: { token_id: serviceToken?.id } }]);
    expect(kept()).toMatchObject({
      hostname: 'ssh-prod.example.com',
      clientId: serviceToken?.client_id,
      clientSecret: { ciphertext: `sealed:${serviceToken?.client_secret}` },
      accessAppId: app?.id,
    });
    expect(again.routed).toHaveLength(3);
    expect(fake.writes().filter((write) => write.path.includes('dns_records'))).toHaveLength(
      fake
        .writes()
        .slice(0, writes)
        .filter((write) => write.path.includes('dns_records')).length,
    );
    expect(fake.accessApps.size).toBe(1);
  });

  it('names the Cloudflare Tunnel permission when the token lacks it', async () => {
    const { ops } = await setup({ grants: { ...ALL_GRANTS } });

    const failure = await ops
      .setUp({ serverId: 'srv-1', cloudflareAccountId: CF_ACCOUNT_ID, sshHostname: null })
      .catch((error: unknown) => error as Error);

    expect(cloudflareErrorCode(failure)).toBe('missing-permission');
    expect(cloudflareErrorPermission(failure)).toBe('tunnel');
  });

  it('closes the web ports as a change set that waits for its confirmation', async () => {
    const { ops, core } = await setup();
    await ops.setUp({ serverId: 'srv-1', cloudflareAccountId: CF_ACCOUNT_ID, sshHostname: null });

    const closed = await ops.closePorts('srv-1');
    await confirm(core, closed.changeSet?.id ?? '');

    expect(closed.status.state).toBe('pending');
    expect((await ops.status('srv-1')).state).toBe('connected');
    expect(core.firewall.rules.some((rule) => rule.port === 80 || rule.port === 443)).toBe(false);
  });

  it('switches SSH to the tunnel only after a test connection got in through it', async () => {
    const probe = vi.fn(async () => '127.0.0.1 40112 127.0.0.1 22');
    const { ops, core, reset, route, sshConnection } = await setup({ probe });
    await ops.setUp({
      serverId: 'srv-1',
      cloudflareAccountId: CF_ACCOUNT_ID,
      sshHostname: 'ssh-prod.example.com',
    });
    await ops.route('srv-1');
    await confirm(core, (await ops.closePorts('srv-1')).changeSet?.id ?? '');
    sshConnection.value = '127.0.0.1 40113 127.0.0.1 22';

    const applied = await ops.applySsh({ serverId: 'srv-1', mode: 'cloudflare' });

    expect(probe).toHaveBeenCalledWith('cloudflare');
    expect(route()).toBe('cloudflare');
    expect(reset).toHaveBeenCalledWith('srv-1');
    expect(applied.changeSet?.state).toBe('awaitingConfirmation');
  });

  it('keeps SSH as it is when the test connection did not come through the tunnel', async () => {
    const { ops, core, route } = await setup({ probe: async () => PUBLIC_SSH });
    await ops.setUp({
      serverId: 'srv-1',
      cloudflareAccountId: CF_ACCOUNT_ID,
      sshHostname: 'ssh-prod.example.com',
    });
    await confirm(core, (await ops.closePorts('srv-1')).changeSet?.id ?? '');

    await expect(ops.applySsh({ serverId: 'srv-1', mode: 'cloudflare' })).rejects.toThrow(
      /rather than through the tunnel/,
    );
    expect(route()).toBeUndefined();
    expect(core.firewall.pending).toBeUndefined();
  });

  it('closes SSH only through the core domain', async () => {
    const { ops, core } = await setup();
    await ops.setUp({ serverId: 'srv-1', cloudflareAccountId: CF_ACCOUNT_ID, sshHostname: null });
    await confirm(core, (await ops.closePorts('srv-1')).changeSet?.id ?? '');

    const preview = await ops.previewSsh({ serverId: 'srv-1', mode: 'closed' });

    expect(preview.firewall?.guard.blocked).toBe(true);
  });

  it('adds the server to Mesh in the tunnel account and tests SSH over its Mesh address', async () => {
    const { ops, fake, kept } = await setup({
      probe: async () => '100.96.0.40 50000 100.96.0.12 22',
    });
    await ops.setUp({ serverId: 'srv-1', cloudflareAccountId: CF_ACCOUNT_ID, sshHostname: null });

    const job = await ops.joinMesh('srv-1');
    const probe = await ops.probeSsh('srv-1', 'mesh');

    expect(job.state).toBe('succeeded');
    expect(fake.meshNodes.size).toBe(1);
    expect(kept()).toMatchObject({
      meshNodeId: [...fake.meshNodes.keys()][0],
      meshAddress: '100.96.0.12',
    });
    expect(probe).toMatchObject({ ok: true, client: '100.96.0.40' });
  });

  it('puts the names back, removes the tunnel and Access, and sends SSH straight again once off', async () => {
    const probe = vi.fn(async () => '127.0.0.1 40112 127.0.0.1 22');
    const { ops, core, fake, route, kept } = await setup({ probe });
    await ops.setUp({
      serverId: 'srv-1',
      cloudflareAccountId: CF_ACCOUNT_ID,
      sshHostname: 'ssh-prod.example.com',
    });
    await ops.route('srv-1');
    await confirm(core, (await ops.closePorts('srv-1')).changeSet?.id ?? '');
    const tunnelId = [...fake.tunnels.keys()][0];

    await expect(ops.cleanUp('srv-1', true)).rejects.toThrow(/off first/);
    const off = await ops.turnOff({ serverId: 'srv-1', reopenWeb: true });
    await confirm(core, off.changeSet?.id ?? '');
    const cleaned = await ops.cleanUp('srv-1', true);

    expect(cleaned.routed.sort()).toEqual([
      'blog.example.com',
      'ssh-prod.example.com',
      'www.example.com',
    ]);
    expect(
      records(fake, 'blog.example.com').map((record) => [
        record.type,
        record.content,
        record.proxied,
      ]),
    ).toEqual([['A', '203.0.113.10', true]]);
    expect(fake.tunnels.get(tunnelId ?? '')?.deleted).toBe(true);
    expect(fake.accessApps.size).toBe(0);
    expect(fake.serviceTokens.size).toBe(0);
    expect(route()).toBeUndefined();
    expect(kept()).toEqual({});
  });
});
