import type {
  CoreDomainMode,
  CoreDomainStatus,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The core domain (E44) between the main process and the renderer: the server core behind a domain
 * in nginx, so the app reaches it without SSH. Straight to the server (Direct), nginx asks for this
 * computer's device certificate and the core checks it, so the domain has to be DNS only. Through
 * Cloudflare, the record is proxied and each request carries a header signed with the device key.
 */

/** What this computer does with a server's core domain. */
export interface DeployCoreDomainRoute {
  /** Whether this computer connects through the domain first. Only while the core says it is ready. */
  enabled: boolean;
  domain: string;
  /** How this computer reaches it; a route saved before modes existed is Direct. */
  mode?: CoreDomainMode;
}

/**
 * Why the domain did not answer from this computer, when a check ran:
 * - `cloudflare-proxy`: Cloudflare answered for it, so the device certificate never reaches nginx.
 * - `no-certificate`: something answered but turned the device certificate down or never saw it.
 * - `not-proxied`: through Cloudflare, but the answer did not come through Cloudflare.
 * - `cloudflare-origin`: Cloudflare answered but could not reach the server or trust its certificate.
 * - `device-proof`: through Cloudflare, the core turned this computer's signed request down.
 * - `clock`: through Cloudflare, this computer's clock is too far off the server's.
 * - `certificate`: the domain's own certificate is not trusted here (expired, self-signed, wrong name).
 * - `unreachable`: no answer at all (DNS, firewall, nginx down).
 */
export type DeployCoreDomainProblem =
  | 'cloudflare-proxy'
  | 'no-certificate'
  | 'not-proxied'
  | 'cloudflare-origin'
  | 'device-proof'
  | 'clock'
  | 'certificate'
  | 'unreachable';

export type DeployCoreDomainCheck =
  | { ok: true; checkedAt: number }
  | { ok: false; checkedAt: number; problem: DeployCoreDomainProblem; message: string };

export interface DeployCoreDomainInfo {
  /** The core's own account of it. */
  status: CoreDomainStatus;
  route: DeployCoreDomainRoute | null;
  /** The last check from this computer, when the domain is ready on the core. */
  check?: DeployCoreDomainCheck;
}

export interface DeployCoreDomainEnableInput {
  serverId: string;
  domain: string;
  /** Addresses or CIDR networks nginx lets in; empty for every address. */
  sources: string[];
  /** Straight to the server (the default) or through Cloudflare's proxy. */
  mode?: CoreDomainMode;
  password?: string;
  totpCode?: string;
}
