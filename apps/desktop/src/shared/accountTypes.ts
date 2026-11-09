/**
 * Runova accounts (E48), as the main process and the renderer share them. Shapes follow the
 * website API contract (docs/website/api-contract.md). Tokens, passphrases and keys never appear
 * here: they stay in the main process.
 */

export interface AccountProfile {
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

export interface AccountSession {
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

export interface AccountActivityEntry {
  id: number;
  action: string;
  teamId: number | null;
  ip: string | null;
  device: string | null;
  at: string;
  details: Record<string, unknown> | null;
}

export interface AccountActivityPage {
  items: AccountActivityEntry[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** What the renderer knows about the sign-in on this computer. */
export type AccountStatus =
  | { state: 'signed-out'; deviceId: string }
  | { state: 'signing-in'; deviceId: string }
  | {
      state: 'signed-in';
      deviceId: string;
      sessionId: number;
      account: { id: number; email: string; displayName: string };
      /** False when there is no OS keychain, so the next start asks to sign in again. */
      rememberedOnDisk: boolean;
      /** The server refused the token: the person must sign in again. */
      needsSignIn: boolean;
    };

/** Proof for a sensitive change, as the website asks for it. */
export interface StepUp {
  password?: string;
  code?: string;
}

/** A refusal from the website API, from its problem details. */
export interface AccountApiProblem {
  status: number;
  type: string;
  detail: string;
  errors?: Record<string, string[]>;
}

export type EncryptionItemName = 'notifications' | 'sync';

export interface EncryptionItem {
  item: EncryptionItemName;
  label: string;
  /** What the person chose. */
  enabled: boolean;
  /** Whether it is really being sealed now. */
  active: boolean;
  /** Chosen, but the plan no longer covers it. */
  lapsed: boolean;
  needsKey: boolean;
}

export interface EncryptionStatus {
  entitled: boolean;
  planName: string;
  items: EncryptionItem[];
}
