import type { ManageScope } from '@runova/protocol';

/**
 * Runova Anywhere (E60 to E62): connecting to any computer by its Runova ID, as a teammate, or
 * with an unattended-access password. These types cross from main to the renderer.
 */

export type AnywherePlatform = 'windows' | 'macos' | 'linux';
export type AnywhereMode = 'ask' | 'password';
export type AnywhereIntent = 'control' | 'files' | 'manage';
export type AnywhereTransport = 'direct' | 'relay';
export type AnywhereRelation = 'own' | 'teammate' | 'other';

export interface AnywherePermissions {
  control: boolean;
  clipboard: boolean;
  files: boolean;
}

/** This computer, as registered on the website. */
export interface AnywhereThisDevice {
  id: number;
  remoteId: string;
  name: string;
  platform: AnywherePlatform;
}

/** A computer this account may connect to: its own, or a teammate's shown to a shared team. */
export interface AnywhereDirectoryEntry {
  id: number;
  remoteId: string;
  name: string;
  platform: AnywherePlatform;
  kind: 'app' | 'agent';
  identityKey: string;
  unattendedEnabled: boolean;
  online: boolean;
  lastSeenAt: string;
  owner: { userId: number; displayName: string; email: string };
  teams: { id: number; name: string }[];
}

export interface AnywhereRecentEntry {
  remoteId: string;
  name: string;
  platform: string;
  at: number;
  /** A password for it is saved in Runova. */
  savedPassword: boolean;
}

export interface AnywhereSettingsView {
  acceptConnections: boolean;
  allowOwnDevices: boolean;
  teamIds: number[];
  alwaysAllow: { userId: number; displayName: string }[];
  alwaysRelay: boolean;
  defaultPermissions: AnywherePermissions;
  /** An unattended-access password is set on this computer. */
  passwordSet: boolean;
  /** The OS keychain can keep this computer's keys; without it no password can be set. */
  canKeepSecrets: boolean;
  /** The background service that keeps this computer reachable while no one is signed in (E64). */
  agent: { installed: boolean; unavailableReason: string | null };
}

export type OutgoingPhase =
  | 'requesting'
  | 'needs-password'
  | 'waiting'
  | 'connecting'
  | 'securing'
  | 'key-changed'
  | 'connected'
  | 'failed';

export interface AnywhereOutgoing {
  phase: OutgoingPhase;
  remoteId: string;
  /** Empty when the other computer belongs to a stranger. */
  hostName: string;
  platform: AnywherePlatform | null;
  mode: AnywhereMode;
  intent: AnywhereIntent;
  transport: AnywhereTransport | null;
  safetyCode: string | null;
  /** When the request stops ringing, for the countdown while waiting for someone to accept. */
  ringsUntil: number | null;
  error: string | null;
  /** The password just tried was wrong. */
  wrongPassword: boolean;
}

export interface AnywhereIncoming {
  sessionId: string;
  mode: AnywhereMode;
  relation: AnywhereRelation;
  intent: AnywhereIntent;
  controller: {
    userId: number;
    displayName: string;
    email: string;
    deviceName: string | null;
    platform: string | null;
    remoteId: string | null;
  };
  teams: string[];
  receivedAt: number;
  expiresAt: number;
}

export interface AnywhereHosted {
  sessionId: string;
  controllerName: string;
  controllerEmail: string;
  deviceName: string | null;
  transport: AnywhereTransport;
  intent: AnywhereIntent;
  permissions: AnywherePermissions;
  startedAt: number;
  safetyCode: string;
}

/** A phone the person at this computer approved, identified by its own key (E71). */
export interface AnywhereTrustedPhone {
  key: string;
  name: string;
  platform: string | null;
  /** What it may do besides the basics. */
  scopes: ManageScope[];
  approvedAt: number;
  lastSeenAt: number;
  connected: boolean;
}

export type AnywhereStatus = 'signed-out' | 'starting' | 'online' | 'offline' | 'error';

/** What this computer still needs before others can see and control it (E63). */
export interface AnywhereReadiness {
  /** Why no one can move the mouse or type here (Wayland, no display), or null. */
  controlUnavailable: string | null;
  /** macOS permissions still to grant: Accessibility for control, Screen Recording for the screen. */
  needs: ('accessibility' | 'screen')[];
}

export interface AnywhereState {
  status: AnywhereStatus;
  error: string | null;
  account: { displayName: string; email: string } | null;
  device: AnywhereThisDevice | null;
  settings: AnywhereSettingsView;
  directory: { mine: AnywhereDirectoryEntry[]; teammates: AnywhereDirectoryEntry[] };
  recent: AnywhereRecentEntry[];
  teams: { id: number; name: string }[];
  outgoing: AnywhereOutgoing | null;
  incoming: AnywhereIncoming[];
  hosted: AnywhereHosted[];
  trustedPhones: AnywhereTrustedPhone[];
  inputPaused: boolean;
  /** Password access is locked until then, after too many wrong passwords. */
  passwordLockedUntil: number | null;
  readiness: AnywhereReadiness;
}

export interface AnywhereConnectRequest {
  remoteId: string;
  intent: AnywhereIntent;
  /** Typed by the person; it never leaves this computer. */
  password?: string;
  /** Keep the secret derived from the password in Runova's vault for next time. */
  savePassword?: boolean;
}

export interface AnywhereIncomingAnswer {
  accept: boolean;
  permissions: AnywherePermissions;
  /** Let this teammate in without asking from now on. */
  alwaysAllow: boolean;
  /** For a phone asking to manage this computer: what it may do once approved. */
  scopes?: ManageScope[];
}

export interface AnywhereSettingsPatch {
  acceptConnections?: boolean;
  allowOwnDevices?: boolean;
  teamIds?: number[];
  alwaysRelay?: boolean;
  defaultPermissions?: AnywherePermissions;
  /** Stop letting these teammates in without asking. */
  removeAlwaysAllow?: number[];
}

export interface AnywhereSessionRecord {
  id: number;
  role: 'host' | 'controller';
  mode: AnywhereMode;
  transport: AnywhereTransport | null;
  hostRemoteId: string;
  hostName: string;
  hostOwnerName: string;
  controllerName: string;
  controllerEmail: string;
  startedAt: string;
  endedAt: string | null;
}

/** Formats a Runova ID as "482 193 775"; anything else is returned as typed. */
export function formatRemoteId(id: string): string {
  const digits = id.replace(/\D/g, '');
  return digits.length === 9
    ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`
    : id;
}

/** The nine digits of a typed or pasted Runova ID, or null. */
export function parseRemoteId(typed: string): string | null {
  const digits = typed.replace(/[\s -]/g, '');
  return /^[1-9]\d{8}$/.test(digits) ? digits : null;
}

/** Formats digits as someone types them, grouping by three and stopping at nine. */
export function formatTypedRemoteId(typed: string): string {
  const digits = typed.replace(/\D/g, '').slice(0, 9);
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

export const EMPTY_ANYWHERE_STATE: AnywhereState = {
  status: 'signed-out',
  error: null,
  account: null,
  device: null,
  settings: {
    acceptConnections: true,
    allowOwnDevices: false,
    teamIds: [],
    alwaysAllow: [],
    alwaysRelay: false,
    defaultPermissions: { control: true, clipboard: true, files: false },
    passwordSet: false,
    canKeepSecrets: true,
    agent: { installed: false, unavailableReason: null },
  },
  directory: { mine: [], teammates: [] },
  recent: [],
  teams: [],
  outgoing: null,
  incoming: [],
  hosted: [],
  trustedPhones: [],
  inputPaused: false,
  passwordLockedUntil: null,
  readiness: { controlUnavailable: null, needs: [] },
};
