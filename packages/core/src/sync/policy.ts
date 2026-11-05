import type { FieldSpec } from './fields.js';

/** What a collection holds, for the encryption policy and the Sync screen. */
export type SyncCategory = 'general' | 'servers' | 'environments' | 'vault' | 'monitoring';

export interface SyncCollection {
  /** The server's collection name: lowercase, 2 to 40 characters. */
  id: string;
  label: string;
  category: SyncCategory;
  fields: FieldSpec;
  /**
   * Every field is a secret (the Vault): nothing goes without a key. The whole item is the
   * secret then, so `fields.secret` stays empty.
   */
  allSecret?: boolean;
  /** Can be shared with a team from its item menu. */
  shareable: boolean;
}

/** What the person (or a team's Owner) chose to encrypt, on top of secrets, which always are. */
export interface EncryptionPolicy {
  servers: boolean;
  environments: boolean;
  everything: boolean;
}

export const DEFAULT_ENCRYPTION_POLICY: EncryptionPolicy = {
  servers: false,
  environments: false,
  everything: false,
};

/**
 * Every collection that syncs. Per-device fields are what only make sense on one computer: local
 * paths, pairing tokens, trust pins taken on this computer, and caches. Secret fields hold sealed
 * secrets (each store seals with the OS keychain or the Servers passkey); the adapter opens them
 * before a sync and seals them again on the other side.
 */
export const SYNC_COLLECTIONS: readonly SyncCollection[] = [
  {
    id: 'projects',
    label: 'Projects',
    category: 'general',
    fields: { device: ['folderPath', 'iconFile', 'wordpress'], secret: [] },
    shareable: true,
  },
  {
    id: 'environments',
    label: 'Environments',
    category: 'environments',
    // The env files and logins hold the sealed contents, passwords and notes, so each whole list
    // travels only sealed. Their saved history stays on this computer.
    fields: { device: [], secret: ['files', 'credentials'] },
    shareable: true,
  },
  {
    id: 'ssh-servers',
    label: 'SSH servers',
    category: 'servers',
    // The host key pin syncs: it is just as useful on every computer.
    fields: { device: ['privateKeyPath', 'lastConnectedAt'], secret: ['secretEnvelope'] },
    shareable: true,
  },
  {
    id: 'rdp-servers',
    label: 'Remote desktops',
    category: 'servers',
    fields: { device: ['lastConnectedAt'], secret: ['secretEnvelope'] },
    shareable: true,
  },
  {
    id: 'database-connections',
    label: 'Database connections',
    category: 'servers',
    // A SQLite file or a container on this computer is never synced at all (the adapter leaves
    // those connections out), so no field here has to hide a local path.
    fields: { device: ['lastUsedAt'], secret: ['passwordEnvelope'] },
    shareable: true,
  },
  {
    id: 'vault-entries',
    label: 'Vault',
    category: 'vault',
    // Categories are this Vault's own and do not sync, so the entry keeps the one it has here.
    fields: { device: ['lastUsedAt', 'categoryId'], secret: [] },
    allSecret: true,
    shareable: true,
  },
  {
    id: 'health-targets',
    label: 'Monitors',
    category: 'monitoring',
    fields: { device: [], secret: ['secretEnvelope'] },
    shareable: true,
  },
  {
    id: 'health-history',
    label: 'Monitoring history',
    category: 'monitoring',
    fields: { device: [], secret: [] },
    shareable: false,
  },
  {
    id: 'api-collections',
    label: 'API client',
    category: 'general',
    // Scripts from somewhere else only run once the person says so, on each computer.
    fields: { device: ['scriptsTrusted'], secret: [] },
    shareable: true,
  },
  {
    id: 'error-tracking',
    label: 'Error tracking connections',
    category: 'servers',
    // A connection is no use without its token, and a stored one must have it, so the whole
    // record travels sealed or not at all. The last check and its problem are this computer's.
    fields: { device: ['checkedAt', 'problem'], secret: [] },
    allSecret: true,
    shareable: true,
  },
  {
    id: 'prompt-templates',
    label: 'Prompt templates',
    category: 'general',
    fields: { device: [], secret: [] },
    shareable: true,
  },
  {
    id: 'blueprints',
    label: 'Blueprints',
    category: 'general',
    // Attachments stay on this computer: the adapter leaves them out, as their files do not travel.
    fields: { device: [], secret: [] },
    shareable: false,
  },
  {
    id: 'settings',
    label: 'Settings',
    category: 'general',
    // The adapter leaves this computer's own settings (local paths, windows, proxy) out of the
    // value, and puts the keys and tokens under `secrets`.
    fields: { device: [], secret: ['secrets'] },
    shareable: false,
  },
];

export function syncCollection(id: string): SyncCollection {
  const collection = SYNC_COLLECTIONS.find((c) => c.id === id);
  if (!collection) throw new Error(`Unknown sync collection: ${id}`);
  return collection;
}

/**
 * How a record of this collection goes to the server:
 * - `needs-key`: not at all, until a key is set (the Vault).
 * - `shared-only`: the shared fields in the clear; secrets stay on this computer.
 * - `seal-secrets`: the shared fields in the clear and the secrets end-to-end encrypted.
 * - `seal-all`: the whole record end-to-end encrypted.
 */
export type Sealing =
  | { mode: 'needs-key' }
  | { mode: 'shared-only' }
  | { mode: 'seal-secrets' }
  | { mode: 'seal-all' };

export function sealingFor(
  collection: SyncCollection,
  policy: EncryptionPolicy,
  hasKey: boolean,
): Sealing {
  if (!hasKey) return collection.allSecret ? { mode: 'needs-key' } : { mode: 'shared-only' };
  if (
    collection.allSecret ||
    policy.everything ||
    (policy.servers && collection.category === 'servers') ||
    (policy.environments && collection.category === 'environments')
  ) {
    return { mode: 'seal-all' };
  }
  return { mode: 'seal-secrets' };
}
