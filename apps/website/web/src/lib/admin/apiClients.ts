/** API clients as the API hands them to an Admin, and what the admin pages make of them. */

export const SCOPES = [
  { value: 'news:write', label: 'Write news' },
  { value: 'posts:write', label: 'Write blog posts' },
] as const;

export interface ApiClientKey {
  keyId: string;
  createdAt: string;
  /** Null for the current key; set on an older key that works until then. */
  expiresAt: string | null;
}

export interface ApiClient {
  id: number;
  name: string;
  scopes: string[];
  ipAllowlist: string[];
  keys: ApiClientKey[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  version: string;
}

/** The answer to a create: the only time the secret comes back. */
export interface ApiClientCreated {
  client: ApiClient;
  keyId: string;
  secret: string;
}

/** The answer to a rotation, with the new key's secret. */
export interface ApiClientSecret {
  keyId: string;
  secret: string;
  previousKeyExpiresAt: string;
}

export type ApiClientStatus = 'active' | 'expired' | 'revoked';

export const STATUS_LABELS: Record<ApiClientStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

export function clientStatus(client: ApiClient, now = Date.now()): ApiClientStatus {
  if (client.revokedAt) return 'revoked';
  if (client.expiresAt && new Date(client.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

/** The key the client signs with now; an older one may still work through its overlap. */
export const currentKey = (client: ApiClient) =>
  client.keys.find((key) => key.expiresAt === null) ?? null;

/** How long the old key keeps working after a rotation, in minutes, as the API takes it. */
export const OVERLAPS = [
  { minutes: 0, label: 'Not at all, stop it now' },
  { minutes: 60, label: 'For 1 hour' },
  { minutes: 1440, label: 'For 1 day' },
  { minutes: 10080, label: 'For 7 days' },
] as const;

export const DEFAULT_OVERLAP = 1440;
