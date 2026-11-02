import type {
  CoreDomainMode,
  CoreDomainStatus,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployCoreDomainCheck,
  DeployCoreDomainEnableInput,
  DeployCoreDomainInfo,
  DeployCoreDomainRoute,
} from '../../../shared/deployCoreDomainTypes';
import type { CoreTransport } from '../connection/transport';
import type { DeployState } from '../state';
import { explainCoreRefusal } from '../system';
import { checkCoreDomain } from './probe';

/**
 * The core domain (E44) from the app's side: what the core says about it, and whether this
 * computer connects through it. This computer only tries the domain once the core says it is
 * ready (nginx runs the site with a certificate, the core's port for nginx is open) and a check
 * from here got through to the core with the device proof (the certificate straight to the
 * server, a signed header through Cloudflare). A domain set up one way and reached the other fails
 * that check with its own explanation instead of failing the link over and over.
 */

/** A core from before modes sends none: that core only knows Direct. */
function modeOf(status: CoreDomainStatus): CoreDomainMode {
  return status.mode ?? 'direct';
}

export interface DeployCoreDomainDeps {
  service: {
    withHub: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
    coreDomainChanged: (serverId: string) => void;
    coreDomainTransport: (
      serverId: string,
      domain: string,
      mode: CoreDomainMode,
    ) => Promise<CoreTransport | null>;
  };
  state: Pick<DeployState, 'coreDomain' | 'setCoreDomain'>;
  /** The signed-in user's roles on a server, when this run of the app knows them. */
  roles: (serverId: string) => string[] | null;
  check?: (
    transport: CoreTransport,
    domain: string,
    mode: CoreDomainMode,
  ) => Promise<DeployCoreDomainCheck>;
  now?: () => number;
}

export class DeployCoreDomain {
  private readonly now: () => number;
  /** The last check per server, for the domain and mode it checked. */
  private readonly checks = new Map<
    string,
    { domain: string; mode: CoreDomainMode; check: DeployCoreDomainCheck }
  >();

  constructor(private readonly deps: DeployCoreDomainDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The core's account, checked from here once when it first reads as ready. */
  async status(serverId: string): Promise<DeployCoreDomainInfo> {
    const status = await this.call(serverId, false, (hub) => hub.getCoreDomain());
    const known = this.checks.get(serverId);
    const fresh =
      status.ready &&
      status.domain &&
      (known?.domain !== status.domain || known.mode !== modeOf(status));
    return this.settle(serverId, status, fresh ? 'check' : 'keep');
  }

  async enable(input: DeployCoreDomainEnableInput): Promise<DeployCoreDomainInfo> {
    const status = await this.call(input.serverId, true, async (hub) => {
      if (input.password || input.totpCode) {
        await hub.stepUp({
          ...(input.password ? { password: input.password } : {}),
          ...(input.totpCode ? { totpCode: input.totpCode } : {}),
        });
      }
      return hub.enableCoreDomain({
        domain: input.domain,
        sources: input.sources,
        mode: input.mode ?? 'direct',
      });
    });
    return this.settle(input.serverId, status, status.ready ? 'check' : 'keep');
  }

  /**
   * Takes the domain out on the core. This computer stops trying it first, so the link is never
   * left waiting on a domain that is going away.
   */
  async disable(serverId: string): Promise<DeployCoreDomainInfo> {
    const route = await this.deps.state.coreDomain(serverId);
    if (route?.enabled) {
      await this.deps.state.setCoreDomain(serverId, { ...route, enabled: false });
      this.deps.service.coreDomainChanged(serverId);
    }
    const status = await this.call(serverId, false, (hub) => hub.disableCoreDomain());
    this.checks.delete(serverId);
    return this.settle(serverId, status, 'keep');
  }

  /** Checks the domain from this computer now, when the core says it is ready. */
  async check(serverId: string): Promise<DeployCoreDomainInfo> {
    const status = await this.call(serverId, false, (hub) => hub.getCoreDomain());
    return this.settle(serverId, status, 'check');
  }

  private async settle(
    serverId: string,
    status: CoreDomainStatus,
    check: 'check' | 'keep',
  ): Promise<DeployCoreDomainInfo> {
    const domain = status.domain;
    const mode = modeOf(status);
    if (!status.ready || !domain) {
      this.checks.delete(serverId);
    } else if (check === 'check') {
      const transport = await this.deps.service.coreDomainTransport(serverId, domain, mode);
      if (transport) {
        const run = this.deps.check ?? ((t, d, m) => checkCoreDomain(t, d, this.now, m));
        const result = await run(transport, domain, mode);
        this.checks.set(serverId, { domain, mode, check: result });
      }
    }

    const known = this.checks.get(serverId);
    const last = known && known.domain === domain && known.mode === mode ? known.check : undefined;
    const saved = await this.deps.state.coreDomain(serverId);
    let route: DeployCoreDomainRoute | null = saved;
    if (domain) {
      // A core that is not ready, or a failed check, stops this computer trying the domain; a
      // passing check starts it. With no check in this run of the app the saved choice stands,
      // as long as it was for the same domain and mode.
      const savedMode = saved?.mode ?? 'direct';
      let enabled: boolean;
      if (!status.ready) enabled = false;
      else if (last) enabled = last.ok;
      else enabled = saved?.domain === domain && savedMode === mode && saved.enabled;
      route = { enabled, domain, mode };
      if (
        saved?.enabled !== route.enabled ||
        saved?.domain !== route.domain ||
        savedMode !== mode
      ) {
        await this.deps.state.setCoreDomain(serverId, route);
        this.deps.service.coreDomainChanged(serverId);
      }
    } else if (saved?.enabled) {
      route = { ...saved, enabled: false };
      await this.deps.state.setCoreDomain(serverId, route);
      this.deps.service.coreDomainChanged(serverId);
    }
    return { status, route, ...(last ? { check: last } : {}) };
  }

  private async call<T>(
    serverId: string,
    stepUp: boolean,
    work: (hub: ICoreHub) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.deps.service.withHub(serverId, work);
    } catch (error) {
      const roles = this.deps.roles(serverId);
      throw explainCoreRefusal(error, roles, stepUp && (!roles || roles.includes('owner')));
    }
  }
}
