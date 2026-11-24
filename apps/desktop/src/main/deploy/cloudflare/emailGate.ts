import type { SecretEnvelope } from '../../../shared/apiTypes';
import {
  emailGateApp,
  emailGateBypassDomain,
  hostnameInZone,
  isEmailGateSession,
  validateEmailGateInput,
  validateTeamName,
} from '../../../shared/cloudflare/emailGate';
import { cloudflareErrorCode } from '../../../shared/cloudflareErrors';
import type {
  CloudflareDnsRecord,
  CloudflareZone,
  EmailGateHost,
  EmailGateInput,
  EmailGateLookup,
  EmailGatePlan,
  EmailGatePrepareInput,
  EmailGateReadiness,
  EmailGateRole,
  EmailGateSession,
  EmailGateState,
  EmailGateTarget,
} from '../../../shared/cloudflareTypes';
import type {
  CloudflareTunnelStatus,
  OriginLockStatus,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { CloudflareApi } from './client';
import { hasCloudflareCode, isNotFound } from './errors';
import { allPages, type CloudflareService } from './service';
import type { CloudflareState } from './state';

/**
 * The email code gate (E96): Cloudflare Access in front of one hostname. A visitor types their
 * email, Cloudflare mails a code (the One-time PIN login), and only the people the policy lists
 * get in. Cloudflare holds the truth, so the Access tab is read from it every time; the only thing
 * kept here is this computer's pass through a gate on a core domain, a service token the core
 * domain transport sends so the app is not stopped by its own gate.
 *
 * Two applications go on a gated name: the gate itself, and one on the certificate challenge path
 * that lets everyone in, so Let's Encrypt can still renew over HTTP-01. Applications the app did
 * not make are shown and never changed.
 */

export interface EmailGateServer {
  id: string;
  name: string;
  /** Whether its link is up; only then is its core asked about its names. */
  online: boolean;
  /** The core domain this computer reaches it at, when it has one on, known without asking. */
  coreDomain: string | null;
}

export interface EmailGateDeps {
  cloudflare: Pick<CloudflareService, 'useApi' | 'allZones' | 'listRecords' | 'updateRecord'>;
  passes: Pick<CloudflareState, 'pass' | 'savePass' | 'removePass'>;
  seal: (plaintext: string) => Promise<SecretEnvelope>;
  /** The saved servers, whose cores say which names are their core domain and sites. */
  servers: () => Promise<EmailGateServer[]>;
  links: { call: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T> };
  /** This computer's name, so a pass says whose it is on Cloudflare's dashboard. */
  computerName: () => string;
  /** How long a core gets to say what its names are before the tab shows them plainly. */
  coreTimeoutMs?: number;
}

const CORE_TIMEOUT_MS = 4_000;
/** How long a core gets to say whether only Cloudflare can reach it, before a gate goes on. */
const CHECK_TIMEOUT_MS = 15_000;
const ONE_TIME_PIN = 'onetimepin';
const PEOPLE_POLICY = 'People with an email code';
const PASS_DURATION = '8760h';
const ROLE_ORDER: Record<EmailGateRole, number> = { core: 0, site: 1, ssh: 2, other: 3 };
const ADDRESS_TYPES = new Set(['A', 'AAAA', 'CNAME']);

const SETUP_FIRST =
  'Turn on email codes for this Cloudflare account first, on the Access tab. It takes one click.';

interface Json {
  [key: string]: unknown;
}

interface AccessApp {
  id: string;
  name: string;
  domain: string;
  type?: string;
  session_duration?: string;
}

interface AccessPolicy {
  id: string;
  decision?: string;
  include?: Json[];
}

interface NameInfo {
  role: EmailGateRole;
  serverId: string;
  serverName: string;
  siteName: string | null;
}

interface Account {
  zone: CloudflareZone;
  /** Runova's id for the saved token that holds the zone. */
  accountId: string;
  /** Cloudflare's id for the account, for the Access API. */
  tag: string;
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function toApp(raw: unknown): AccessApp | null {
  const app = raw as Json;
  if (typeof app?.id !== 'string' || typeof app.domain !== 'string') return null;
  return {
    id: app.id,
    name: typeof app.name === 'string' ? app.name : '',
    domain: app.domain.toLowerCase(),
    ...(typeof app.type === 'string' ? { type: app.type } : {}),
    ...(typeof app.session_duration === 'string' ? { session_duration: app.session_duration } : {}),
  };
}

function toPolicy(raw: unknown): AccessPolicy | null {
  const policy = raw as Json;
  if (typeof policy?.id !== 'string') return null;
  return {
    id: policy.id,
    ...(typeof policy.decision === 'string' ? { decision: policy.decision } : {}),
    ...(Array.isArray(policy.include) ? { include: policy.include as Json[] } : {}),
  };
}

/** The hostname an Access application covers, without a path. */
function hostOf(domain: string): string {
  return domain.split('/')[0] ?? domain;
}

function peopleOf(policy: AccessPolicy | undefined): { emails: string[]; emailDomains: string[] } {
  const emails: string[] = [];
  const emailDomains: string[] = [];
  for (const rule of policy?.include ?? []) {
    const email = lower((rule.email as Json | undefined)?.email);
    const domain = lower((rule.email_domain as Json | undefined)?.domain);
    if (email) emails.push(email);
    if (domain) emailDomains.push(domain);
  }
  return { emails, emailDomains };
}

function tokensOf(policies: AccessPolicy[]): string[] {
  return policies
    .filter((policy) => policy.decision === 'non_identity')
    .flatMap((policy) => policy.include ?? [])
    .map((rule) => (rule.service_token as Json | undefined)?.token_id)
    .filter((id): id is string => typeof id === 'string');
}

function include(input: { emails: string[]; emailDomains: string[] }): Json[] {
  return [
    ...input.emails.map((email) => ({ email: { email: email.toLowerCase() } })),
    ...input.emailDomains.map((domain) => ({ email_domain: { domain: domain.toLowerCase() } })),
  ];
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class CloudflareEmailGateOps {
  constructor(private readonly deps: EmailGateDeps) {}

  /** Every name of the zone, what it is to the app, and whether a gate is on it. */
  async plan(zoneId: string): Promise<EmailGatePlan> {
    const account = await this.account(zoneId);
    const readiness = await this.readiness(account);
    const [records, apps, names] = await Promise.all([
      this.deps.cloudflare.listRecords(zoneId),
      this.apps(account),
      this.names(account.zone),
    ]);
    const passes = new Map<string, string>();
    const hostnames = new Set<string>();
    const byName = new Map<string, CloudflareDnsRecord[]>();
    for (const record of records) {
      if (!ADDRESS_TYPES.has(record.type) || record.name.startsWith('*')) continue;
      const name = record.name.toLowerCase();
      hostnames.add(name);
      byName.set(name, [...(byName.get(name) ?? []), record]);
    }
    for (const app of apps) {
      const name = hostOf(app.domain);
      if (hostnameInZone(name, account.zone.name) && !emailGateApp.isOurBypass(app)) {
        hostnames.add(name);
      }
    }
    for (const name of names.keys()) hostnames.add(name);
    const hosts: EmailGateHost[] = [];
    for (const hostname of hostnames) {
      const named = byName.get(hostname) ?? [];
      const info = names.get(hostname);
      const gate = await this.gateOf(account, hostname, apps);
      if (gate.kind === 'on') {
        const pass = await this.deps.passes.pass(hostname);
        if (pass?.appId === gate.appId) passes.set(hostname, pass.appId);
      }
      hosts.push({
        hostname,
        proxied: named.some((record) => record.proxied),
        recordId: named[0]?.id ?? null,
        role: info?.role ?? 'other',
        serverId: info?.serverId ?? null,
        serverName: info?.serverName ?? null,
        siteName: info?.siteName ?? null,
        gate,
        thisComputerPass: passes.has(hostname),
      });
    }
    hosts.sort(
      (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.hostname.localeCompare(b.hostname),
    );
    return { cloudflareAccountId: account.tag, readiness, hosts };
  }

  /**
   * One name's gate and its zone, or null when no connected zone holds the name (or no Cloudflare
   * account is connected at all), so a shortcut on another page simply does not show.
   */
  async find(hostname: string): Promise<EmailGateLookup | null> {
    const name = hostname.trim().toLowerCase();
    let zones: CloudflareZone[];
    try {
      zones = await this.deps.cloudflare.allZones();
    } catch (error) {
      if (cloudflareErrorCode(error) === 'no-token') return null;
      throw error;
    }
    const zone = zones
      .filter((candidate) => hostnameInZone(name, candidate.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!zone) return null;
    const plan = await this.plan(zone.id);
    const host = plan.hosts.find((candidate) => candidate.hostname === name);
    return host ? { zone, readiness: plan.readiness, host } : null;
  }

  /** Sets Zero Trust up when it is not (with the team name given), then the One-time PIN login. */
  async prepare(input: EmailGatePrepareInput): Promise<EmailGateReadiness> {
    const account = await this.account(input.zoneId);
    const current = await this.readiness(account);
    if (current.organization && current.oneTimePin) return current;
    let teamDomain = current.teamDomain;
    if (!current.organization) {
      const teamName = input.teamName?.trim() ?? '';
      const problem = validateTeamName(teamName);
      if (problem) throw new Error(problem);
      teamDomain = `${teamName}.cloudflareaccess.com`;
      const domain = teamDomain;
      await this.deps.cloudflare.useApi(account.accountId, 'accessLogin', async (api) => {
        try {
          await api.zeroTrust.organizations.create({
            account_id: account.tag,
            auth_domain: domain,
            name: teamName,
          } as never);
        } catch (error) {
          if (hasCloudflareCode(error, 12112)) {
            throw new Error(
              `${domain} belongs to another Cloudflare account. Pick another team name.`,
            );
          }
          throw error;
        }
      });
    }
    await this.deps.cloudflare.useApi(account.accountId, 'accessLogin', async (api) => {
      await api.zeroTrust.identityProviders.create({
        account_id: account.tag,
        name: 'One-time PIN',
        type: ONE_TIME_PIN,
        config: {},
      } as never);
    });
    return { organization: true, teamDomain, oneTimePin: true };
  }

  /** Puts the gate on a name, or changes who gets in and for how long. */
  async save(input: EmailGateInput): Promise<EmailGateState> {
    const account = await this.account(input.zoneId);
    const hostname = input.hostname.toLowerCase();
    const problem = validateEmailGateInput({ ...input, hostname }, account.zone.name);
    if (problem) throw new Error(problem);
    const records = await this.deps.cloudflare.listRecords(input.zoneId);
    const proxied = records.some(
      (record) => record.name.toLowerCase() === hostname && record.proxied,
    );
    if (!proxied) {
      throw new Error(
        `Turn on Cloudflare's proxy (the orange cloud) for ${hostname} first. The gate only works on names Cloudflare answers for.`,
      );
    }
    const readiness = await this.readiness(account);
    if (!readiness.organization || !readiness.oneTimePin) throw new Error(SETUP_FIRST);
    const info = (await this.names(account.zone)).get(hostname);
    if (info && info.role !== 'ssh') await this.requireOnlyCloudflare(info);
    const apps = await this.apps(account);
    const ours = apps.find((app) => app.domain === hostname && emailGateApp.isOurs(app));
    const other = apps.find(
      (app) =>
        hostOf(app.domain) === hostname &&
        !emailGateApp.isOurs(app) &&
        !emailGateApp.isOurBypass(app),
    );
    if (!ours && other) {
      throw new Error(
        `${hostname} already has an Access application, ${other.name || 'made elsewhere'}. Change it on Cloudflare's Zero Trust dashboard, or remove it there first.`,
      );
    }
    const isCore = info?.role === 'core';
    const otp = await this.oneTimePinId(account);
    const appId = ours
      ? await this.update(account, ours.id, hostname, input, otp)
      : await this.create(account, hostname, input, otp);
    if (!apps.some((app) => app.domain === emailGateBypassDomain(hostname))) {
      await this.bypass(account, hostname);
    }
    if (isCore) {
      const pass = await this.deps.passes.pass(hostname);
      if (pass?.appId !== appId) await this.issuePass(account, hostname, appId);
    }
    return {
      kind: 'on',
      appId,
      emails: input.emails.map((email) => email.toLowerCase()),
      emailDomains: input.emailDomains.map((domain) => domain.toLowerCase()),
      session: input.session,
    };
  }

  /** Takes the gate off a name: both its applications, and every pass through it. */
  async remove(target: EmailGateTarget): Promise<void> {
    const account = await this.account(target.zoneId);
    const hostname = target.hostname.toLowerCase();
    const apps = await this.apps(account);
    const ours = apps.filter(
      (app) =>
        (app.domain === hostname && emailGateApp.isOurs(app)) ||
        (app.domain === emailGateBypassDomain(hostname) && emailGateApp.isOurBypass(app)),
    );
    await this.deps.cloudflare.useApi(account.accountId, 'access', async (api) => {
      for (const app of ours) {
        const tokens = tokensOf(await this.policies(api, account, app.id));
        await api.zeroTrust.access.applications
          .delete(app.id, { account_id: account.tag })
          .catch((error: unknown) => {
            if (!isNotFound(error)) throw error;
          });
        for (const token of tokens) {
          await api.zeroTrust.access.serviceTokens
            .delete(token, { account_id: account.tag })
            .catch((error: unknown) => {
              if (!isNotFound(error)) throw error;
            });
        }
      }
    });
    await this.deps.passes.removePass(hostname);
  }

  /** A pass of this computer's own through the gate on a core domain. */
  async letThisComputerThrough(target: EmailGateTarget): Promise<void> {
    const account = await this.account(target.zoneId);
    const hostname = target.hostname.toLowerCase();
    const ours = (await this.apps(account)).find(
      (app) => app.domain === hostname && emailGateApp.isOurs(app),
    );
    if (!ours) throw new Error(`${hostname} has no email code gate from this app.`);
    const pass = await this.deps.passes.pass(hostname);
    if (pass?.appId === ours.id) return;
    await this.issuePass(account, hostname, ours.id);
  }

  /** Turns Cloudflare's proxy on for every address record of a name. */
  async proxy(target: EmailGateTarget): Promise<void> {
    const hostname = target.hostname.toLowerCase();
    const records = (await this.deps.cloudflare.listRecords(target.zoneId)).filter(
      (record) =>
        record.name.toLowerCase() === hostname &&
        ADDRESS_TYPES.has(record.type) &&
        record.proxiable &&
        !record.proxied,
    );
    for (const record of records) {
      await this.deps.cloudflare.updateRecord(target.zoneId, record.id, {
        type: record.type as 'A' | 'AAAA' | 'CNAME',
        name: record.name,
        content: record.content,
        ttl: 1,
        proxied: true,
        ...(record.comment ? { comment: record.comment } : {}),
      });
    }
  }

  /**
   * Access only runs at Cloudflare's edge. A server that still answers anyone on 80 and 443 serves
   * the gated name to whoever finds its address and asks it directly, so the gate only goes on a
   * name of a server that is locked to Cloudflare with Authenticated Origin Pulls, or that is
   * behind a tunnel with its web ports closed.
   */
  private async requireOnlyCloudflare(info: NameInfo): Promise<void> {
    const timeout = Math.max(this.deps.coreTimeoutMs ?? CORE_TIMEOUT_MS, CHECK_TIMEOUT_MS);
    let lock: OriginLockStatus;
    let tunnel: CloudflareTunnelStatus;
    try {
      [lock, tunnel] = await withTimeout(
        this.deps.links.call(info.serverId, (hub) =>
          Promise.all([hub.getOriginLock(), hub.getCloudflareTunnel()]),
        ),
        timeout,
      );
    } catch {
      throw new Error(
        `The app could not ask ${info.serverName} whether only Cloudflare can reach it, and the gate needs that. Connect to the server and try again.`,
      );
    }
    if (tunnel.state === 'connected') return;
    if (lock.state === 'on' && lock.authenticatedOriginPulls) return;
    throw new Error(
      `${info.serverName} still answers anyone who finds its address, and they would get past the gate. Lock it to Cloudflare with Authenticated Origin Pulls on, or put it behind a tunnel with the web ports closed, then turn the gate on.`,
    );
  }

  private async account(zoneId: string): Promise<Account> {
    const zone = (await this.deps.cloudflare.allZones()).find((item) => item.id === zoneId);
    if (!zone) throw new Error('That domain is not in a connected Cloudflare account any more.');
    if (!zone.cloudflareAccountId) {
      throw new Error(
        'Cloudflare did not say which account this domain is in, so Access cannot be set up for it.',
      );
    }
    return { zone, accountId: zone.accountId, tag: zone.cloudflareAccountId };
  }

  private readiness(account: Account): Promise<EmailGateReadiness> {
    return this.deps.cloudflare.useApi(account.accountId, 'accessLogin', async (api) => {
      let teamDomain: string | null = null;
      try {
        const organization = (await api.zeroTrust.organizations.list({
          account_id: account.tag,
        } as never)) as unknown as Json | null;
        teamDomain =
          typeof organization?.auth_domain === 'string' ? organization.auth_domain : null;
      } catch (error) {
        if (!isNotFound(error) && !hasCloudflareCode(error, 12130)) throw error;
      }
      if (!teamDomain) return { organization: false, teamDomain: null, oneTimePin: false };
      const providers = await this.providers(api, account);
      return {
        organization: true,
        teamDomain,
        oneTimePin: providers.some((provider) => provider.type === ONE_TIME_PIN),
      };
    });
  }

  private async providers(api: CloudflareApi, account: Account): Promise<Json[]> {
    return (await allPages(
      (page) =>
        api.zeroTrust.identityProviders.list({
          account_id: account.tag,
          page,
          per_page: 50,
        } as never) as never,
    )) as Json[];
  }

  private oneTimePinId(account: Account): Promise<string> {
    return this.deps.cloudflare.useApi(account.accountId, 'accessLogin', async (api) => {
      const otp = (await this.providers(api, account)).find(
        (provider) => provider.type === ONE_TIME_PIN,
      );
      if (typeof otp?.id !== 'string') throw new Error(SETUP_FIRST);
      return otp.id;
    });
  }

  private apps(account: Account): Promise<AccessApp[]> {
    return this.deps.cloudflare.useApi(account.accountId, 'access', async (api) => {
      const raw = await allPages(
        (page) =>
          api.zeroTrust.access.applications.list({
            account_id: account.tag,
            page,
            per_page: 50,
          } as never) as never,
      );
      return (raw as unknown[]).map(toApp).filter((app): app is AccessApp => app !== null);
    });
  }

  private async policies(
    api: CloudflareApi,
    account: Account,
    appId: string,
  ): Promise<AccessPolicy[]> {
    const raw = await allPages(
      (page) =>
        api.zeroTrust.access.applications.policies.list(appId, {
          account_id: account.tag,
          page,
          per_page: 50,
        } as never) as never,
    );
    return (raw as unknown[]).map(toPolicy).filter((policy): policy is AccessPolicy => !!policy);
  }

  private async gateOf(
    account: Account,
    hostname: string,
    apps: AccessApp[],
  ): Promise<EmailGateState> {
    const ours = apps.find((app) => app.domain === hostname && emailGateApp.isOurs(app));
    if (ours) {
      const policies = await this.deps.cloudflare.useApi(account.accountId, 'access', (api) =>
        this.policies(api, account, ours.id),
      );
      const people = peopleOf(policies.find((policy) => policy.decision === 'allow'));
      const session: EmailGateSession = isEmailGateSession(ours.session_duration)
        ? ours.session_duration
        : '24h';
      return { kind: 'on', appId: ours.id, ...people, session };
    }
    const other = apps.find(
      (app) => hostOf(app.domain) === hostname && !emailGateApp.isOurBypass(app),
    );
    if (other) return { kind: 'elsewhere', appId: other.id, name: other.name };
    return { kind: 'off' };
  }

  private appBody(account: Account, hostname: string, session: EmailGateSession, otp: string) {
    return {
      account_id: account.tag,
      name: emailGateApp.name(hostname),
      domain: hostname,
      type: 'self_hosted',
      session_duration: session,
      allowed_idps: [otp],
      auto_redirect_to_identity: true,
      app_launcher_visible: false,
    };
  }

  private create(
    account: Account,
    hostname: string,
    input: EmailGateInput,
    otp: string,
  ): Promise<string> {
    return this.deps.cloudflare.useApi(account.accountId, 'access', async (api) => {
      const app = toApp(
        await api.zeroTrust.access.applications.create(
          this.appBody(account, hostname, input.session, otp) as never,
        ),
      );
      if (!app) throw new Error('Cloudflare made the Access application but did not say its id.');
      try {
        await api.zeroTrust.access.applications.policies.create(app.id, {
          account_id: account.tag,
          name: PEOPLE_POLICY,
          decision: 'allow',
          include: include(input),
        } as never);
      } catch (error) {
        // Never leave a gate that lets nobody in.
        await api.zeroTrust.access.applications
          .delete(app.id, { account_id: account.tag })
          .catch(() => undefined);
        throw error;
      }
      return app.id;
    });
  }

  private update(
    account: Account,
    appId: string,
    hostname: string,
    input: EmailGateInput,
    otp: string,
  ): Promise<string> {
    return this.deps.cloudflare.useApi(account.accountId, 'access', async (api) => {
      const { account_id, ...body } = this.appBody(account, hostname, input.session, otp);
      await api.zeroTrust.access.applications.update(appId, { account_id, ...body } as never);
      const allow = (await this.policies(api, account, appId)).find(
        (policy) => policy.decision === 'allow',
      );
      const policy = {
        account_id: account.tag,
        name: PEOPLE_POLICY,
        decision: 'allow',
        include: include(input),
      };
      if (allow) {
        await api.zeroTrust.access.applications.policies.update(allow.id, {
          ...policy,
          app_id: appId,
        } as never);
      } else {
        await api.zeroTrust.access.applications.policies.create(appId, policy as never);
      }
      return appId;
    });
  }

  /** Everyone on the certificate challenge path, so HTTP-01 renewals still reach the server. */
  private bypass(account: Account, hostname: string): Promise<void> {
    return this.deps.cloudflare.useApi(account.accountId, 'access', async (api) => {
      const app = toApp(
        await api.zeroTrust.access.applications.create({
          account_id: account.tag,
          name: emailGateApp.bypassName(hostname),
          domain: emailGateBypassDomain(hostname),
          type: 'self_hosted',
          session_duration: '24h',
          app_launcher_visible: false,
        } as never),
      );
      if (!app) return;
      await api.zeroTrust.access.applications.policies.create(app.id, {
        account_id: account.tag,
        name: 'Certificate checks',
        decision: 'bypass',
        include: [{ everyone: {} }],
      } as never);
    });
  }

  /** A service token for this computer, let in by a policy of its own, sealed here. */
  private async issuePass(account: Account, hostname: string, appId: string): Promise<void> {
    const made = await this.deps.cloudflare.useApi(account.accountId, 'access', async (api) => {
      const token = await api.zeroTrust.access.serviceTokens.create({
        account_id: account.tag,
        name: `Runova app on ${this.deps.computerName()}, ${hostname}`.slice(0, 100),
        duration: PASS_DURATION,
      });
      if (!token.id || !token.client_id || !token.client_secret) {
        throw new Error('Cloudflare made the service token but did not return it.');
      }
      const policy = toPolicy(
        await api.zeroTrust.access.applications.policies.create(appId, {
          account_id: account.tag,
          name: `This app on ${this.deps.computerName()}`.slice(0, 100),
          decision: 'non_identity',
          include: [{ service_token: { token_id: token.id } }],
        } as never),
      );
      return {
        tokenId: token.id,
        clientId: token.client_id,
        clientSecret: token.client_secret,
        policyId: policy?.id ?? '',
      };
    });
    await this.deps.passes.savePass({
      hostname,
      cloudflareAccountId: account.tag,
      appId,
      policyId: made.policyId || 'unknown',
      serviceTokenId: made.tokenId,
      clientId: made.clientId,
      clientSecret: await this.deps.seal(made.clientSecret),
    });
  }

  /**
   * What each name of the zone is to the app. The core domain each server is reached at is known
   * here; sites and SSH's name come from cores whose link is up. A core that does not answer in
   * time is skipped, so the tab still opens with its names shown plainly, and the core domain
   * still gets this computer's pass.
   */
  private async names(zone: CloudflareZone): Promise<Map<string, NameInfo>> {
    const names = new Map<string, NameInfo>();
    const timeout = this.deps.coreTimeoutMs ?? CORE_TIMEOUT_MS;
    const servers = await this.deps.servers().catch(() => []);
    const found = await Promise.all(
      servers.map(async (server) => {
        const ask = <T>(work: (hub: ICoreHub) => Promise<T>): Promise<T | null> =>
          server.online
            ? withTimeout(this.deps.links.call(server.id, work), timeout).catch(() => null)
            : Promise.resolve(null);
        const [domain, sites, tunnel] = await Promise.all([
          ask((hub) => hub.getCoreDomain()),
          ask((hub) => hub.listSites()),
          ask((hub) => hub.getCloudflareTunnel()),
        ]);
        const entries: [string, NameInfo][] = [];
        const add = (name: string | undefined, role: EmailGateRole, siteName: string | null) => {
          const hostname = lower(name);
          if (hostname && hostnameInZone(hostname, zone.name)) {
            entries.push([
              hostname,
              { role, serverId: server.id, serverName: server.name, siteName },
            ]);
          }
        };
        add(server.coreDomain ?? undefined, 'core', null);
        if (domain?.enabled) add(domain.domain, 'core', null);
        for (const site of sites ?? []) {
          for (const name of site.settings.domains) add(name, 'site', site.settings.id);
        }
        add(tunnel?.sshHostname, 'ssh', null);
        return entries;
      }),
    );
    for (const [hostname, info] of found.flat()) {
      const known = names.get(hostname);
      if (!known || ROLE_ORDER[info.role] < ROLE_ORDER[known.role]) names.set(hostname, info);
    }
    return names;
  }
}
