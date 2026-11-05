import { syncCollection, VAULT_LIMITS, type VaultEntry } from '@runova/core';
import { fromAnotherComputer } from './copyName';
import { recordStoreAdapter } from './recordStore';

/** The parts of `VaultService` sync uses. None of them count as use of the vault. */
export interface VaultEntriesPort {
  isUnlocked: () => boolean;
  entriesForSync: () => VaultEntry[];
  putFromSync: (entry: VaultEntry) => Promise<void>;
  removeFromSync: (id: string) => Promise<void>;
}

/**
 * Vault entries (E48). The vault can only be read while it is unlocked, so the engine waits for
 * that. Every field is a secret: an entry travels only sealed with the scope's key, and not at
 * all without one (policy.ts). The last use and the category, which is this vault's own, stay
 * on this computer.
 */
export function vaultEntriesAdapter(vault: VaultEntriesPort) {
  return recordStoreAdapter<VaultEntry>({
    collection: syncCollection('vault-entries'),
    area: 'vault',
    ready: () => vault.isUnlocked(),
    list: async () => vault.entriesForSync(),
    put: (entry) => vault.putFromSync(entry),
    remove: (id) => vault.removeFromSync(id),
    id: (entry) => entry.id,
    fromValue: (value, existing) => {
      const { categoryId: _category, ...entry } = value as unknown as VaultEntry;
      return {
        ...entry,
        lastUsedAt: existing?.lastUsedAt ?? null,
        ...(existing?.categoryId ? { categoryId: existing.categoryId } : {}),
      } as VaultEntry;
    },
    duplicate: (value) => ({
      ...value,
      title: fromAnotherComputer(value.title, VAULT_LIMITS.title),
    }),
  });
}
