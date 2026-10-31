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

/** An Admin can do everything an Editor can, so an account shows one role. */
export const roleOf = (user: Pick<StaffUser, 'roles'>): Role =>
  user.roles.includes('Admin') ? 'Admin' : 'Editor';

export type UserStatus = 'active' | 'invited' | 'disabled';

export const STATUS_LABELS: Record<UserStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
};

/** Disabled wins; someone who never set a password from their link is still invited. */
export function userStatus(user: StaffUser): UserStatus {
  if (user.disabled) return 'disabled';
  if (!user.emailConfirmed) return 'invited';
  return 'active';
}

/** The token in a set-password link's fragment (`#token=...`), or null when there is none. */
export function setupToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
}
