import type { RecordBatchParams } from 'cloudflare/resources/dns/records';
import type { SecretEnvelope, SshRoute, StoredTunnelSsh } from '../../../shared/apiTypes';
import type {
  CloudflareDnsRecord,
  CloudflareSshProbe,
  CloudflareTunnelAccount,
  CloudflareTunnelBreakGlassInput,
  CloudflareTunnelDomain,
  CloudflareTunnelOffInput,
  CloudflareTunnelPlan,
  CloudflareTunnelRouteResult,
  CloudflareTunnelSetupInput,
  CloudflareTunnelSshInput,
  CloudflareZone,
} from '../../../shared/cloudflareTypes';
import { encodeCoreError } from '../../../shared/coreErrors';
import type {
  CloudflareTunnelPreview,
  CloudflareTunnelResult,
  CloudflareTunnelStatus,
  JobInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { ADMIN_ROLES, callCore } from '../coreCalls';
import type { CoreLinks } from '../live/coreLinks';
import { planChanges, type ServerAddresses } from './pointDomain';
import { zoneOf } from './serverOps';
import type { CloudflareService } from './service';

/**
 * The Cloudflare Tunnel from the main process (E95). The account token stays here: this side makes
 * the tunnel at Cloudflare, routes its names (a proxied CNAME per name, one catch-all ingress that
 * hands everything to nginx's loopback listener), and sets up Cloudflare Access for SSH and the
 * server's Mesh node. The core only ever receives the tunnel's own token and the Mesh node's.
 * Firewall steps ride the lasting connection with `$SSH_CONNECTION` as any firewall change does,
 * except that a change to who may open SSH goes over the way in that will remain, so the core's
 * lockout guard checks exactly that one.
 */

export interface CloudflareTunnelDeps {
  cloudflare: Pick<CloudflareService, 'useApi' | 'allZones' | 'listRecords' | 'status'>;
  links: Pick<CoreLinks, 'call'>;
  roles: (serverId: string) => string[] | null;
  onLinkConnection: <T>(
    serverId: string,
    work: (sshConnection: string | undefined) => Promise<T>,
  ) => Promise<T>;
  serverName: (serverId: string) => Promise<string>;
  /** The server's public addresses, for pointing its names back at it when the tunnel goes. */
  addresses: (serverId: string) => Promise<ServerAddresses>;
  tunnelSsh: {
    read: (serverId: string) => Promise<StoredTunnelSsh>;
    update: (
      serverId: string,
      change: (current: StoredTunnelSsh) => StoredTunnelSsh | undefined,
      route?: SshRoute | null,
    ) => Promise<void>;
    seal: (plaintext: string) => Promise<SecretEnvelope>;
  };
  /** `$SSH_CONNECTION` over a brand-new SSH connection that takes this route. */
  probeSsh: (serverId: string, route: SshRoute) => Promise<string>;
  /** Drops the server's SSH connections, so the next ones take its new route. */
  resetSsh: (serverId: string) => void;
  /** A hub call through the core domain, the way in that remains with SSH closed. */
  withCoreDomainHub: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
}

const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const NGINX_NOT_READY =
  'The tunnel hands every request to nginx, and nginx is not set up for Runova on this server yet. Set it up under Websites first.';
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const MESH = /^100\.(9[6-9]|10\d|11[01])\.\d+\.\d+$/;

/** Where a name points to reach a tunnel. */
export function tunnelTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

/**
 * The record changes that point names at a tunnel: their address records go and one proxied CNAME
 * to the tunnel stays. Running it again finds every name already right and changes nothing.
 */
export function planTunnelRecords(
  names: string[],
  target: string,
  existing: CloudflareDnsRecord[],
): { deletes: CloudflareDnsRecord[]; patches: CloudflareDnsRecord[]; posts: string[] } {
  const deletes: CloudflareDnsRecord[] = [];
  const patches: CloudflareDnsRecord[] = [];
  const posts: string[] = [];
  for (const name of names) {
    const at = existing.filter((record) => record.name === name && ADDRESS_TYPES.has(record.type));
    deletes.push(...at.filter((record) => record.type !== 'CNAME'));
    const cnames = at.filter((record) => record.type === 'CNAME');
    const [keep, ...extra] = cnames;
    deletes.push(...extra);
    if (!keep) posts.push(name);
    else if (keep.content !== target || !keep.proxied) patches.push(keep);
  }
  return { deletes, patches, posts };
}

/** The client address in `$SSH_CONNECTION` ("client port server port"). */
function clientOf(sshConnection: string): string | null {
  const client = sshConnection.trim().split(/\s+/)[0];
  return client ? client : null;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'server'
  );
}

export class CloudflareTunnelOps {
  constructor(private readonly deps: CloudflareTunnelDeps) {}

  status(serverId: string): Promise<CloudflareTunnelStatus> {
    return this.core(serverId, (hub) => hub.getCloudflareTunnel());
  }

  /** The accounts that can hold the tunnel, each name's state, and what the firewall would do. */
  async plan(serverId: string): Promise<CloudflareTunnelPlan> {
    const status = await this.status(serverId);
    const coreDomain = await this.core(serverId, (hub) => hub.getCoreDomain()).catch(() => null);
    const ports = await this.deps.onLinkConnection(serverId, (sshConnection) =>
      this.core(serverId, (hub) =>
        hub.previewCloudflareTunnelPorts(sshConnection ? { sshConnection } : {}),
      ),
    );
    const zones = await this.deps.cloudflare.allZones();
    const domains = await this.domains(serverId, status, zones);
    const labels = new Map(
      (await this.deps.cloudflare.status()).accounts.map((account) => [account.id, account.label]),
    );
    const accounts = new Map<string, CloudflareTunnelAccount>();
    for (const zone of zones) {
      const known = accounts.get(zone.cloudflareAccountId);
      const held = domains
        .filter((domain) => domain.zoneId === zone.id && domain.role !== 'ssh')
        .map((domain) => domain.domain);
      if (known) known.domains.push(...held);
      else {
        accounts.set(zone.cloudflareAccountId, {
          cloudflareAccountId: zone.cloudflareAccountId,
          label: labels.get(zone.accountId) ?? 'Cloudflare',
          domains: held,
        });
      }
    }
    const ordered = [...accounts.values()].sort((a, b) => b.domains.length - a.domains.length);
    const first = ordered[0];
    const firstZone = first
      ? (zones.find(
          (zone) =>
            zone.cloudflareAccountId === first.cloudflareAccountId &&
            domains.some((domain) => domain.zoneId === zone.id),
        ) ?? zones.find((zone) => zone.cloudflareAccountId === first.cloudflareAccountId))
      : undefined;
    return {
      status,
      accounts: ordered,
      domains,
      coreDomain:
        coreDomain?.enabled && coreDomain.domain
          ? { domain: coreDomain.domain, mode: coreDomain.mode }
          : null,
      ports,
      suggestedSshHostname:
        status.sshHostname ??
        (firstZone ? `ssh-${slug(await this.deps.serverName(serverId))}.${firstZone.name}` : null),
      blocker: (await this.nginxReady(serverId)) ? null : NGINX_NOT_READY,
    };
  }

  private async nginxReady(serverId: string): Promise<boolean> {
    const nginx = await this.core(serverId, (hub) => hub.getNginxStatus());
    return nginx.installed && nginx.running && nginx.managed;
  }

  /**
   * Makes the tunnel at Cloudflare (or takes the server's own again) and hands the core its
   * token; the core's job installs cloudflared and connects. Nothing in the firewall changes.
   */
  async setUp(input: CloudflareTunnelSetupInput): Promise<JobInfo> {
    this.requireAdmin(input.serverId);
    // Nothing is made at Cloudflare for a server that cannot run the tunnel yet.
    if (!(await this.nginxReady(input.serverId))) throw new Error(NGINX_NOT_READY);
    const accountId = await this.accountFor(input.cloudflareAccountId);
    const status = await this.status(input.serverId);
    const name = `runova-${slug(await this.deps.serverName(input.serverId))}`;
    let tunnelId = status.accountTag === input.cloudflareAccountId ? status.tunnelId : undefined;
    if (tunnelId) {
      const existing = tunnelId;
      tunnelId = await this.deps.cloudflare
        .useApi(accountId, 'tunnel', (api) =>
          api.zeroTrust.tunnels.cloudflared.get(existing, {
            account_id: input.cloudflareAccountId,
          }),
        )
        .then((tunnel) => (tunnel.deleted_at ? undefined : tunnel.id))
        .catch(() => undefined);
    }
    if (!tunnelId) {
      const created = await this.deps.cloudflare.useApi(accountId, 'tunnel', (api) =>
        api.zeroTrust.tunnels.cloudflared.create({
          account_id: input.cloudflareAccountId,
          name,
          config_src: 'cloudflare',
        }),
      );
      if (!created.id) throw new Error('Cloudflare made the tunnel but did not say its id.');
      tunnelId = created.id;
    }
    const id = tunnelId;
    const token = await this.deps.cloudflare.useApi(accountId, 'tunnel', (api) =>
      api.zeroTrust.tunnels.cloudflared.token.get(id, { account_id: input.cloudflareAccountId }),
    );
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Cloudflare did not hand out the tunnel token.');
    }
    return this.core(input.serverId, (hub) =>
      hub.startCloudflareTunnel({
        tunnelId: id,
        tunnelName: name,
        token,
        ...(input.sshHostname ? { sshHostname: input.sshHostname.trim().toLowerCase() } : {}),
      }),
    );
  }

  /**
   * Once the tunnel is connected: one catch-all route to nginx (and SSH's name to sshd), every
   * name of the server in the tunnel's account pointed at the tunnel, and Cloudflare Access in
   * front of SSH's name with a service token only this app holds.
   */
  async route(serverId: string): Promise<CloudflareTunnelRouteResult> {
    this.requireAdmin(serverId);
    const status = await this.status(serverId);
    const { tunnelId, accountTag, tunnelPort } = status;
    if (!status.enabled || !tunnelId || !accountTag || !tunnelPort) {
      throw new Error('Set the tunnel up first.');
    }
    const accountId = await this.accountFor(accountTag);
    const sshPort = status.sshPorts[0] ?? 22;
    await this.deps.cloudflare.useApi(accountId, 'tunnel', (api) =>
      api.zeroTrust.tunnels.cloudflared.configurations.update(tunnelId, {
        account_id: accountTag,
        config: {
          // SSH's name to sshd, then everything else to nginx's loopback listener, which
          // answers only the names it serves.
          ingress: [
            ...(status.sshHostname
              ? [{ hostname: status.sshHostname, service: `ssh://localhost:${sshPort}` }]
              : []),
            { service: `http://127.0.0.2:${tunnelPort}` },
          ],
        } as never,
      }),
    );
    if (status.sshHostname)
      await this.accessForSsh(serverId, accountId, accountTag, status.sshHostname);

    const zones = await this.deps.cloudflare.allZones();
    const domains = await this.domains(serverId, status, zones);
    const routed: string[] = [];
    const skipped: string[] = [];
    const byZone = new Map<string, string[]>();
    for (const domain of domains) {
      if (!domain.zoneId || domain.cloudflareAccountId !== accountTag) {
        skipped.push(domain.domain);
        continue;
      }
      byZone.set(domain.zoneId, [...(byZone.get(domain.zoneId) ?? []), domain.domain]);
    }
    const target = tunnelTarget(tunnelId);
    for (const [zoneId, names] of byZone) {
      const plan = planTunnelRecords(names, target, await this.deps.cloudflare.listRecords(zoneId));
      if (plan.deletes.length + plan.patches.length + plan.posts.length > 0) {
        await this.deps.cloudflare.useApi(accountId, 'dns', (api) =>
          api.dns.records.batch({
            zone_id: zoneId,
            deletes: plan.deletes.map((record) => ({ id: record.id })),
            patches: plan.patches.map((record) => ({
              id: record.id,
              type: 'CNAME',
              name: record.name,
              content: target,
              proxied: true,
              ttl: 1,
            })),
            posts: plan.posts.map((name) => ({
              type: 'CNAME',
              name,
              content: target,
              proxied: true,
              ttl: 1,
            })),
          } as RecordBatchParams),
        );
      }
      routed.push(...names);
    }
    return { routed, skipped };
  }

  async closePorts(serverId: string): Promise<CloudflareTunnelResult> {
    this.requireAdmin(serverId);
    return this.deps.onLinkConnection(serverId, (sshConnection) =>
      this.core(serverId, (hub) =>
        hub.closeCloudflareTunnelPorts(sshConnection ? { sshConnection } : {}),
      ),
    );
  }

  async previewSsh(input: CloudflareTunnelSshInput): Promise<CloudflareTunnelPreview> {
    if (input.mode === 'closed') {
      return this.deps.withCoreDomainHub(input.serverId, (hub) =>
        hub.previewTunnelSsh({ mode: 'closed' }),
      );
    }
    return this.deps.onLinkConnection(input.serverId, (sshConnection) =>
      this.core(input.serverId, (hub) =>
        hub.previewTunnelSsh({ mode: input.mode, ...(sshConnection ? { sshConnection } : {}) }),
      ),
    );
  }

  /** Whether SSH gets in over a route now, from the address the server should see. */
  async probeSsh(serverId: string, route: SshRoute): Promise<CloudflareSshProbe> {
    if (route === 'mesh') await this.rememberMeshAddress(serverId);
    try {
      const client = clientOf(await this.deps.probeSsh(serverId, route));
      const expected = route === 'cloudflare' ? LOOPBACK : MESH;
      if (!client || !expected.test(client)) {
        return {
          ok: false,
          client,
          message:
            route === 'cloudflare'
              ? `SSH got in, but from ${client ?? 'an unknown address'} rather than through the tunnel.`
              : `SSH got in, but from ${client ?? 'an unknown address'} rather than a Mesh address. Turn on the Cloudflare One Client on this computer.`,
        };
      }
      return {
        ok: true,
        client,
        message:
          route === 'cloudflare'
            ? 'SSH gets in through the tunnel.'
            : `SSH gets in over Mesh from ${client}.`,
      };
    } catch (error) {
      return { ok: false, client: null, message: (error as Error).message };
    }
  }

  /**
   * Who may open SSH. Cloudflare only and Mesh are applied over that route, after a test
   * connection over it worked, so the core's lockout guard sees the connection that remains.
   * Closed goes over the core domain with the guard's phrase and a step-up.
   */
  async applySsh(input: CloudflareTunnelSshInput): Promise<CloudflareTunnelResult> {
    this.requireAdmin(input.serverId);
    if (input.mode === 'closed') {
      return this.deps.withCoreDomainHub(input.serverId, async (hub) => {
        if (input.password || input.totpCode) {
          await hub.stepUp({
            ...(input.password ? { password: input.password } : {}),
            ...(input.totpCode ? { totpCode: input.totpCode } : {}),
          });
        }
        return hub.applyTunnelSsh({
          mode: 'closed',
          ...(input.overrideConfirmation
            ? { overrideConfirmation: input.overrideConfirmation }
            : {}),
        });
      });
    }
    if (input.mode === 'cloudflare' || input.mode === 'mesh') {
      const probe = await this.probeSsh(input.serverId, input.mode);
      if (!probe.ok) throw new Error(probe.message);
      await this.deps.tunnelSsh.update(input.serverId, (current) => current, input.mode);
      this.deps.resetSsh(input.serverId);
    }
    return this.deps.onLinkConnection(input.serverId, (sshConnection) =>
      this.core(input.serverId, (hub) =>
        hub.applyTunnelSsh({ mode: input.mode, ...(sshConnection ? { sshConnection } : {}) }),
      ),
    );
  }

  async previewOff(input: CloudflareTunnelOffInput): Promise<CloudflareTunnelPreview> {
    return this.deps.onLinkConnection(input.serverId, (sshConnection) =>
      this.core(input.serverId, (hub) =>
        hub.previewCloudflareTunnelOff({
          reopenWeb: input.reopenWeb,
          ...(sshConnection ? { sshConnection } : {}),
        }),
      ),
    );
  }

  /** Opens what the tunnel closed; the core stops cloudflared once that is kept. */
  async turnOff(input: CloudflareTunnelOffInput): Promise<CloudflareTunnelResult> {
    this.requireAdmin(input.serverId);
    return this.deps.onLinkConnection(input.serverId, (sshConnection) =>
      this.core(input.serverId, (hub) =>
        hub.turnOffCloudflareTunnel({
          reopenWeb: input.reopenWeb,
          ...(sshConnection ? { sshConnection } : {}),
        }),
      ),
    );
  }

  /**
   * After the tunnel is off: the names point straight at the server again (proxied, so the
   * origin lock can take over), and the tunnel, SSH's Access and the Mesh node go at Cloudflare.
   * SSH goes straight to the server again.
   */
  async cleanUp(serverId: string, pointBack: boolean): Promise<CloudflareTunnelRouteResult> {
    this.requireAdmin(serverId);
    const status = await this.status(serverId);
    if (status.enabled) throw new Error('Turn the tunnel off first.');
    const routed: string[] = [];
    const skipped: string[] = [];
    const { tunnelId, accountTag } = status;
    if (tunnelId && accountTag) {
      const accountId = await this.accountFor(accountTag);
      const target = tunnelTarget(tunnelId);
      if (pointBack) {
        const addresses = await this.deps.addresses(serverId);
        for (const zone of (await this.deps.cloudflare.allZones()).filter(
          (candidate) => candidate.cloudflareAccountId === accountTag,
        )) {
          const records = await this.deps.cloudflare.listRecords(zone.id);
          const names = [
            ...new Set(
              records
                .filter((record) => record.type === 'CNAME' && record.content === target)
                .map((record) => record.name),
            ),
          ];
          if (names.length === 0) continue;
          const changes = planChanges({ names, addresses, proxied: true, existing: records });
          await this.deps.cloudflare.useApi(accountId, 'dns', (api) =>
            api.dns.records.batch({
              zone_id: zone.id,
              deletes: changes
                .filter((change) => change.action === 'delete')
                .map((change) => ({ id: change.recordId })),
              posts: changes
                .filter((change) => change.action === 'create')
                .map((change) => ({
                  type: change.type,
                  name: change.name,
                  content: change.content,
                  proxied: true,
                  ttl: 1,
                })),
            } as RecordBatchParams),
          );
          routed.push(...names);
        }
      }
      await this.deps.cloudflare
        .useApi(accountId, 'tunnel', async (api) => {
          await api.zeroTrust.tunnels.cloudflared.connections
            .delete(tunnelId, { account_id: accountTag })
            .catch(() => undefined);
          await api.zeroTrust.tunnels.cloudflared.delete(tunnelId, { account_id: accountTag });
        })
        .catch(() => skipped.push(`the tunnel ${status.tunnelName ?? tunnelId}`));
      const kept = await this.deps.tunnelSsh.read(serverId);
      if (kept.accessAppId || kept.serviceTokenId) {
        await this.deps.cloudflare
          .useApi(accountId, 'access', async (api) => {
            if (kept.accessAppId) {
              await api.zeroTrust.access.applications.delete(kept.accessAppId, {
                account_id: accountTag,
              });
            }
            if (kept.serviceTokenId) {
              await api.zeroTrust.access.serviceTokens.delete(kept.serviceTokenId, {
                account_id: accountTag,
              });
            }
          })
          .catch(() => skipped.push(`SSH's Access application`));
      }
      if (kept.meshNodeId) {
        const node = kept.meshNodeId;
        await this.deps.cloudflare
          .useApi(accountId, 'mesh', (api) =>
            api.zeroTrust.tunnels.warpConnector.delete(node, { account_id: accountTag }),
          )
          .catch(() => skipped.push('the Mesh node'));
      }
    }
    await this.deps.tunnelSsh.update(serverId, () => undefined, null);
    this.deps.resetSsh(serverId);
    return { routed, skipped };
  }

  /** Makes the server a Cloudflare Mesh node in the tunnel's account. */
  async joinMesh(serverId: string): Promise<JobInfo> {
    this.requireAdmin(serverId);
    const status = await this.status(serverId);
    if (!status.enabled || !status.accountTag) throw new Error('Set the tunnel up first.');
    const accountTag = status.accountTag;
    const accountId = await this.accountFor(accountTag);
    const kept = await this.deps.tunnelSsh.read(serverId);
    let nodeId = kept.meshNodeId;
    if (!nodeId) {
      const name = `runova-${slug(await this.deps.serverName(serverId))}`;
      const created = await this.deps.cloudflare.useApi(accountId, 'mesh', (api) =>
        api.zeroTrust.tunnels.warpConnector.create({ account_id: accountTag, name }),
      );
      if (!created.id) throw new Error('Cloudflare made the Mesh node but did not say its id.');
      nodeId = created.id;
      const made = nodeId;
      await this.deps.tunnelSsh.update(serverId, (current) => ({ ...current, meshNodeId: made }));
    }
    const node = nodeId;
    const token = await this.deps.cloudflare.useApi(accountId, 'mesh', (api) =>
      api.zeroTrust.tunnels.warpConnector.token.get(node, { account_id: accountTag }),
    );
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Cloudflare did not hand out the Mesh node token.');
    }
    return this.core(serverId, (hub) => hub.joinCloudflareMesh({ nodeId: node, token }));
  }

  breakGlass(input: CloudflareTunnelBreakGlassInput): Promise<CloudflareTunnelStatus> {
    return this.core(input.serverId, (hub) =>
      hub.setTunnelBreakGlass({ enabled: input.enabled, delayMinutes: input.delayMinutes }),
    );
  }

  /** Access in front of SSH's name, letting in only a service token this app keeps sealed. */
  private async accessForSsh(
    serverId: string,
    accountId: string,
    accountTag: string,
    hostname: string,
  ): Promise<void> {
    const kept = await this.deps.tunnelSsh.read(serverId);
    if (kept.hostname === hostname && kept.accessAppId && kept.clientId && kept.clientSecret)
      return;
    const serverName = await this.deps.serverName(serverId);
    const result = await this.deps.cloudflare.useApi(accountId, 'access', async (api) => {
      const serviceToken = await api.zeroTrust.access.serviceTokens.create({
        account_id: accountTag,
        name: `Runova SSH, ${serverName}`.slice(0, 100),
        duration: '8760h',
      });
      if (!serviceToken.id || !serviceToken.client_id || !serviceToken.client_secret) {
        throw new Error('Cloudflare made the service token but did not return it.');
      }
      const application = await api.zeroTrust.access.applications.create({
        account_id: accountTag,
        name: `Runova SSH, ${serverName}`.slice(0, 100),
        domain: hostname,
        type: 'ssh',
        session_duration: '24h',
        app_launcher_visible: false,
      } as never);
      const appId = (application as { id?: string }).id;
      if (!appId) throw new Error('Cloudflare made the Access application but did not say its id.');
      await api.zeroTrust.access.applications.policies.create(appId, {
        account_id: accountTag,
        name: 'This app only',
        decision: 'non_identity',
        include: [{ service_token: { token_id: serviceToken.id } }],
      } as never);
      return {
        appId,
        tokenId: serviceToken.id,
        clientId: serviceToken.client_id,
        clientSecret: serviceToken.client_secret,
      };
    });
    const sealed = await this.deps.tunnelSsh.seal(result.clientSecret);
    await this.deps.tunnelSsh.update(serverId, (current) => ({
      ...current,
      hostname,
      clientId: result.clientId,
      clientSecret: sealed,
      accessAppId: result.appId,
      serviceTokenId: result.tokenId,
    }));
  }

  private async rememberMeshAddress(serverId: string): Promise<void> {
    const status = await this.status(serverId);
    if (!status.meshAddress) {
      throw new Error('This server is not a Cloudflare Mesh node yet. Add it to Mesh first.');
    }
    const address = status.meshAddress;
    await this.deps.tunnelSsh.update(serverId, (current) => ({ ...current, meshAddress: address }));
  }

  private async domains(
    serverId: string,
    status: CloudflareTunnelStatus,
    zones: CloudflareZone[],
  ): Promise<CloudflareTunnelDomain[]> {
    const sites = await this.core(serverId, (hub) => hub.listSites());
    const coreDomain = await this.core(serverId, (hub) => hub.getCoreDomain()).catch(() => null);
    const named = new Map<string, CloudflareTunnelDomain['role']>();
    for (const site of sites) {
      for (const domain of site.settings.domains) named.set(domain.toLowerCase(), 'site');
    }
    if (coreDomain?.enabled && coreDomain.domain)
      named.set(coreDomain.domain.toLowerCase(), 'core');
    if (status.sshHostname) named.set(status.sshHostname.toLowerCase(), 'ssh');
    const target = status.tunnelId ? tunnelTarget(status.tunnelId) : null;
    const records = new Map<string, CloudflareDnsRecord[]>();
    const result: CloudflareTunnelDomain[] = [];
    for (const [domain, role] of named) {
      const zone = zoneOf(domain, zones);
      if (!zone) {
        result.push({
          domain,
          role,
          zoneId: null,
          zoneName: null,
          cloudflareAccountId: null,
          routed: false,
        });
        continue;
      }
      if (target && !records.has(zone.id)) {
        records.set(zone.id, await this.deps.cloudflare.listRecords(zone.id));
      }
      const routed =
        target !== null &&
        (records.get(zone.id) ?? []).some(
          (record) =>
            record.name === domain &&
            record.type === 'CNAME' &&
            record.content === target &&
            record.proxied,
        );
      result.push({
        domain,
        role,
        zoneId: zone.id,
        zoneName: zone.name,
        cloudflareAccountId: zone.cloudflareAccountId,
        routed,
      });
    }
    return result;
  }

  /** The connected account that holds zones in this Cloudflare account. */
  private async accountFor(cloudflareAccountId: string): Promise<string> {
    const zone = (await this.deps.cloudflare.allZones()).find(
      (candidate) => candidate.cloudflareAccountId === cloudflareAccountId,
    );
    if (!zone) {
      throw new Error(
        'No connected Cloudflare account holds that account. Connect it on the Cloudflare page first.',
      );
    }
    return zone.accountId;
  }

  /** Nothing is made at Cloudflare for a server whose core would refuse it anyway. */
  private requireAdmin(serverId: string): void {
    const roles = this.deps.roles(serverId);
    if (roles && !roles.some((role) => ADMIN_ROLES.has(role))) {
      throw new Error(
        encodeCoreError(
          'forbidden',
          `Your role on this server (${roles.join(', ')}) cannot do that.`,
        ),
      );
    }
  }

  private core<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    return callCore({ links: this.deps.links, roles: this.deps.roles }, serverId, work);
  }
}
