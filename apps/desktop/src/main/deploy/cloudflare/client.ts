import { BaseAccounts } from 'cloudflare/resources/accounts/accounts';
import { BaseBotManagement } from 'cloudflare/resources/bot-management/bot-management';
import { BaseCache } from 'cloudflare/resources/cache/cache';
import { BaseRecords } from 'cloudflare/resources/dns/records';
import { BaseAccessRules } from 'cloudflare/resources/firewall/access-rules';
import { BaseManagedTransforms } from 'cloudflare/resources/managed-transforms/managed-transforms';
import { BaseOriginCACertificates } from 'cloudflare/resources/origin-ca-certificates/origin-ca-certificates';
import { BasePhases } from 'cloudflare/resources/rulesets/phases/phases';
import { BaseRules } from 'cloudflare/resources/rulesets/rules';
import { BaseRulesets } from 'cloudflare/resources/rulesets/rulesets';
import { BaseWidgets } from 'cloudflare/resources/turnstile/widgets';
import { BasePermissionGroups } from 'cloudflare/resources/user/tokens/permission-groups';
import { BaseTokens } from 'cloudflare/resources/user/tokens/tokens';
import { BaseApplications } from 'cloudflare/resources/zero-trust/access/applications/applications';
import { BasePolicies as BaseAccessPolicies } from 'cloudflare/resources/zero-trust/access/applications/policies';
import { BaseServiceTokens } from 'cloudflare/resources/zero-trust/access/service-tokens';
import { BaseIdentityProviders } from 'cloudflare/resources/zero-trust/identity-providers/identity-providers';
import { BaseOrganizations } from 'cloudflare/resources/zero-trust/organizations/organizations';
import { BaseCloudflared } from 'cloudflare/resources/zero-trust/tunnels/cloudflared/cloudflared';
import { BaseConfigurations as BaseTunnelConfigurations } from 'cloudflare/resources/zero-trust/tunnels/cloudflared/configurations';
import { BaseConnections as BaseTunnelConnections } from 'cloudflare/resources/zero-trust/tunnels/cloudflared/connections';
import { BaseToken as BaseTunnelToken } from 'cloudflare/resources/zero-trust/tunnels/cloudflared/token';
import { BaseToken as BaseConnectorToken } from 'cloudflare/resources/zero-trust/tunnels/warp-connector/token';
import { BaseWARPConnector } from 'cloudflare/resources/zero-trust/tunnels/warp-connector/warp-connector';
import { BaseActivationCheck } from 'cloudflare/resources/zones/activation-check';
import { BaseSettings } from 'cloudflare/resources/zones/settings';
import { BaseZones } from 'cloudflare/resources/zones/zones';
import { createClient } from 'cloudflare/tree-shakable';

/**
 * The official Cloudflare SDK, built with only the parts of the API the page uses. Every option
 * that the SDK would otherwise read from the environment is set here, so a CLOUDFLARE_BASE_URL or
 * CLOUDFLARE_API_KEY in the user's shell can never send the token elsewhere or add a second
 * credential; and it never logs, since a debug log would print requests.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export type CloudflareFetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareClientOptions {
  /** Tests pass a fake; otherwise the global fetch at call time, which the proxy setting swaps. */
  fetch?: CloudflareFetch;
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Only the e2e run sets this (see `cloudflareApiBase`), to reach the recorded fake on loopback;
   * nothing in the user's environment can.
   */
  baseURL?: string;
}

const silent = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

export function createCloudflareApi(token: string, options: CloudflareClientOptions = {}) {
  return createClient({
    resources: [
      BaseTokens,
      BaseZones,
      BaseActivationCheck,
      BaseSettings,
      BaseRecords,
      BaseCache,
      BaseRulesets,
      BasePhases,
      BaseRules,
      BaseAccessRules,
      BaseOriginCACertificates,
      BasePermissionGroups,
      BaseWidgets,
      BaseAccounts,
      BaseBotManagement,
      // Visitor location headers for the traffic report (E109).
      BaseManagedTransforms,
      // The Cloudflare Tunnel (E95): the tunnel, its routes and token, Access for SSH, Mesh nodes.
      BaseCloudflared,
      BaseTunnelConfigurations,
      BaseTunnelConnections,
      BaseTunnelToken,
      BaseWARPConnector,
      BaseConnectorToken,
      BaseApplications,
      BaseAccessPolicies,
      BaseServiceTokens,
      // The email code gate (E96): Zero Trust's team domain and its One-time PIN login.
      BaseOrganizations,
      BaseIdentityProviders,
    ],
    apiToken: token,
    apiKey: null,
    apiEmail: null,
    userServiceKey: null,
    baseURL: options.baseURL ?? CLOUDFLARE_API,
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 30_000,
    logLevel: 'off',
    logger: silent,
  });
}

export type CloudflareApi = ReturnType<typeof createCloudflareApi>;
