import type { CoreDomainStatus } from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The core domain (E44) between the main process and the renderer: the server core behind a domain
 * in nginx, so the app reaches it without SSH. nginx asks for this computer's device certificate
 * and the core checks it, so the domain has to point straight at the server (DNS only).
 */

/** What this computer does with a server's core domain. */
export interface DeployCoreDomainRoute {
  /** Whether this computer connects through the domain first. Only while the core says it is ready. */
  enabled: boolean;
  domain: string;
}

/**
 * Why the domain did not answer from this computer, when a check ran:
 * - `cloudflare-proxy`: Cloudflare answered for it, so the device certificate never reaches nginx.
 * - `no-certificate`: something answered but turned the device certificate down or never saw it.
 * - `certificate`: the domain's own certificate is not trusted here (expired, self-signed, wrong name).
 * - `unreachable`: no answer at all (DNS, firewall, nginx down).
 */
export type DeployCoreDomainProblem =
  | 'cloudflare-proxy'
  | 'no-certificate'
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
  password?: string;
  totpCode?: string;
}
