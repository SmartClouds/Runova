/** Staff accounts as the API hands them to an Admin, and what the admin pages make of them. */

export const ROLES = ['Editor', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_HINTS: Record<Role, string> = {
  Editor: 'Writes the news and the blog.',
  Admin: 'Also manages API clients, users and the jobs dashboard.',
};

export interface StaffUser {
  id: number;
  email: string;
  displayName: string;
  roles: string[];
  disabled: boolean;
  emailConfirmed: boolean;
  twoFactorEnabled: boolean;
  lockedOutUntil: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  version: string;
}

/** A link that sets a password once, from an invitation or a password reset. */
export interface SetupLink {
  url: string;
  expiresAt: string;
}

export interface UserInvited {
  user: StaffUser;
  setupLink: SetupLink;
}

/** A staff role, or `Account` for someone who signed up for Runova and has no staff role. */
export type UserKind = Role | 'Account';

/** The kinds the users list filters by, in the order its select shows them. */
export const USER_KINDS: readonly UserKind[] = ['Admin', 'Editor', 'Account'];

export const KIND_LABELS: Record<UserKind, string> = {
  Admin: 'Admin',
  Editor: 'Editor',
  Account: 'Runova account',
};

/** An Admin can do everything an Editor can, so a user shows one role, or none at all. */
export function roleOf(user: Pick<StaffUser, 'roles'>): UserKind {
  if (user.roles.includes('Admin')) return 'Admin';
  if (user.roles.includes('Editor')) return 'Editor';
  return 'Account';
}

export const isStaffUser = (user: Pick<StaffUser, 'roles'>) => roleOf(user) !== 'Account';

export type UserStatus = 'active' | 'invited' | 'unverified' | 'disabled';

export const STATUS_LABELS: Record<UserStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  unverified: 'Email not verified',
  disabled: 'Disabled',
};

/**
 * Disabled wins. Staff who never set a password from their link are still invited; an account
 * that signed up and never opened its verification email is unverified.
 */
export function userStatus(user: StaffUser): UserStatus {
  if (user.disabled) return 'disabled';
  if (!user.emailConfirmed) return isStaffUser(user) ? 'invited' : 'unverified';
  return 'active';
}

/** The token in a set-password link's fragment (`#token=...`), or null when there is none. */
export function setupToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}
