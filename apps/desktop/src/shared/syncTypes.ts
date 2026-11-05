/**
 * Cloud sync and teams (E48), as the renderer sees them. Keys, passphrases and opened secrets
 * never appear here; a conflict's secret fields come masked.
 */

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out';

export interface SyncPolicy {
  servers: boolean;
  environments: boolean;
  everything: boolean;
}

export interface SyncScopeView {
  id: number;
  kind: 'personal' | 'team';
  teamId: number | null;
  name: string;
  canWrite: boolean;
  canManage: boolean;
  /** The scope has an end-to-end key on the server. */
  hasKey: boolean;
  /** This computer holds that key (it was set or unlocked here). */
  unlockedHere: boolean;
  policy: SyncPolicy;
}

export interface SyncCollectionView {
  id: string;
  label: string;
  category: 'general' | 'servers' | 'environments' | 'vault' | 'monitoring';
  enabled: boolean;
  /** Every field is a secret, so it waits for a key. */
  needsKey: boolean;
  shareable: boolean;
}

export interface SyncConflictView {
  scopeId: number;
  scopeName: string;
  collection: string;
  collectionLabel: string;
  itemId: string;
  /** A name to show: the item's name, title or host. */
  title: string;
  /** This computer's version, with secrets masked. Null when it was deleted here. */
  mine: Record<string, unknown> | null;
  /** The other computer's version, with secrets masked. Null when it was deleted there. */
  theirs: Record<string, unknown> | null;
  changedFields: string[];
  canKeepBoth: boolean;
  detectedAt: number;
}

export interface SyncOverview {
  phase: SyncPhase;
  lastSyncedAt: number | null;
  error: string | null;
  conflicts: number;
  /** Scopes with sealed records this computer can not open yet. */
  needsKey: number[];
  scopes: SyncScopeView[];
  collections: SyncCollectionView[];
}

export interface SyncUsageView {
  records: number;
  bytes: number;
  quotaBytes: number;
  collections: Record<string, number>;
}

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface TeamView {
  id: number;
  name: string;
  role: TeamRole;
  memberCount: number;
  scopeId: number;
  createdAt: string;
}

export interface TeamMemberView {
  userId: number;
  email: string;
  displayName: string;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamInvitationView {
  id: number;
  email: string;
  role: TeamRole;
  createdAt: string;
  expiresAt: string;
}

export interface MyInvitationView {
  id: number;
  teamId: number;
  teamName: string;
  role: TeamRole;
  invitedBy: string;
  expiresAt: string;
}

/** The items of one collection that can be shared, for the Share with a team dialog. */
export interface ShareableGroup {
  collection: string;
  label: string;
  items: { id: string; title: string; teamId: number | null }[];
}

/** What can be shared with a team from its item menu. */
export interface ShareTarget {
  collection: string;
  itemId: string;
  /** The team to share with, or null to make it the person's own again. */
  teamId: number | null;
}
