// API clients and staff users as the API answers them to an Admin, in the shapes of the contract.

export const API_CLIENT = {
  id: 3,
  name: 'Advisory importer',
  scopes: ['news:write'],
  ipAllowlist: ['203.0.113.0/24'],
  keys: [{ keyId: 'rk_5f2c9a1e7b3d4c60', createdAt: '2026-10-01T08:00:00.000Z', expiresAt: null }],
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: '2026-10-30T11:58:02.000Z',
  createdAt: '2026-10-01T08:00:00.000Z',
  version: '887',
};

export const SECRET = 'rnv_sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const NEW_SECRET = 'rnv_sk_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';

export const STAFF_USER = {
  id: 7,
  email: 'editor@runovahq.com',
  displayName: 'Sam Editor',
  roles: ['Editor'],
  disabled: false,
  emailConfirmed: true,
  twoFactorEnabled: true,
  lockedOutUntil: null,
  lastSignInAt: '2026-10-30T09:12:44.000Z',
  createdAt: '2026-10-01T08:00:00.000Z',
  version: '1234',
};

export const SETUP_LINK = {
  url: 'https://runovahq.com/admin/set-password#token=dG9rZW4tZm9yLXRlc3RzLW9ubHktMzItYnl0ZXMtbG9uZw',
  expiresAt: '2026-11-01T09:00:00.000Z',
};

export const page = (items: unknown[], at = 1, totalPages = 1) => ({
  items,
  page: at,
  pageSize: 20,
  totalItems: items.length,
  totalPages,
});
