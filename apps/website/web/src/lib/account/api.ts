/**
 * The account panel's calls to the website API (E48), on the same origin with the session cookie
 * and the antiforgery header (lib/admin/api.ts does the request itself). Shapes follow
 * docs/website/api-contract.md.
 */
export { type ApiResponse, apiRequest, type Problem } from '../admin/api';

/**
 * A path inside the account panel, or the panel's home: never another origin or the sign-in page.
 * Only the path is checked; the query may hold anything (the desktop sign-in carries a loopback URL).
 */
export function safeAccountPath(next: string | null): string {
  const path = next?.split(/[?#]/, 1)[0] ?? '';
  if (!next || !/^\/account(?:\/|$)/.test(path) || /[\\]|\/\/|:/.test(path)) return '/account';
  if (/^\/account\/(?:sign-in|register)(?:\/|$)/.test(path)) return '/account';
  return next;
}

export interface Account {
  id: number;
  email: string;
  displayName: string;
  emailConfirmed: boolean;
  hasPassword: boolean;
  twoFactorEnabled: boolean;
  logins: string[];
  staff: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  version: string;
}

export interface Session {
  id: number;
  kind: 'web' | 'desktop';
  deviceName: string;
  platform: string;
  appVersion: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface Activity {
  id: number;
  action: string;
  teamId: number | null;
  ip: string | null;
  device: string | null;
  at: string;
  details: Record<string, unknown> | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface SyncScope {
  id: number;
  kind: 'personal' | 'team';
  teamId: number | null;
  name: string;
  canWrite: boolean;
  canManage: boolean;
  latestRevision: number;
  epoch: number;
  keyVersion: number | null;
  policy: { servers: boolean; environments: boolean; everything: boolean };
}

export interface SyncUsage {
  records: number;
  bytes: number;
  quotaBytes: number;
  collections: Record<string, number>;
}

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Team {
  id: number;
  name: string;
  role: TeamRole;
  memberCount: number;
  scopeId: number;
  createdAt: string;
}

export interface TeamMember {
  userId: number;
  email: string;
  displayName: string;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamInvitation {
  id: number;
  email: string;
  role: TeamRole;
  createdAt: string;
  expiresAt: string;
}

export interface MyInvitation {
  id: number;
  teamId: number;
  teamName: string;
  role: TeamRole;
  invitedBy: string;
  expiresAt: string;
}

export interface StepUp {
  password: string | null;
  code: string | null;
}

/** The names people see for the synced collections, matching the app's Sync screen. */
export const COLLECTION_LABELS: Record<string, string> = {
  projects: 'Projects',
  environments: 'Environments',
  'ssh-servers': 'SSH servers',
  'rdp-servers': 'Remote desktops',
  'database-connections': 'Database connections',
  'vault-entries': 'Vault',
  'health-targets': 'Monitors',
  'health-history': 'Monitoring history',
  'api-collections': 'API client',
  'error-tracking': 'Error tracking',
  'prompt-templates': 'Prompt templates',
  blueprints: 'Blueprints',
  settings: 'Settings',
};

export const ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export const ROLE_HINTS: Record<TeamRole, string> = {
  owner: 'Everything, including other Owners and deleting the team',
  admin: 'Invites people and manages Members and Viewers',
  member: 'Reads and changes what the team shares',
  viewer: 'Reads what the team shares, never changes it',
};
