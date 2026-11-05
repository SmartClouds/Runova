import type { VaultEntry } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { TEAM_FIELD } from './arrayStore';
import { vaultEntriesAdapter } from './vaultEntries';

function entry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'v1',
    type: 'login',
    title: 'GitHub',
    tags: [],
    favorite: false,
    notes: '',
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: 9,
    categoryId: 'work',
    username: 'octo',
    password: 'S3NT1NEL-password',
    urls: ['https://github.com'],
    totpSecret: '',
    passwordUpdatedAt: null,
    ...overrides,
  } as VaultEntry;
}

function memoryVault(initial: VaultEntry[] = [], unlocked = true) {
  let entries = structuredClone(initial);
  const state = { unlocked };
  return {
    port: {
      isUnlocked: () => state.unlocked,
      entriesForSync: () => {
        if (!state.unlocked) throw new Error('The vault is locked.');
        return structuredClone(entries);
      },
      putFromSync: async (next: VaultEntry) => {
        const index = entries.findIndex((one) => one.id === next.id);
        if (index === -1) entries.push(structuredClone(next));
        else entries[index] = structuredClone(next);
      },
      removeFromSync: async (id: string) => {
        entries = entries.filter((one) => one.id !== id);
      },
    },
    state,
    get: () => entries,
  };
}

describe('vaultEntriesAdapter', () => {
  it('waits while the vault is locked', () => {
    const vault = memoryVault([], false);
    const adapter = vaultEntriesAdapter(vault.port);

    expect(adapter.ready?.()).toBe(false);
    vault.state.unlocked = true;
    expect(adapter.ready?.()).toBe(true);
  });

  it('lists whole entries with their team apart', async () => {
    const vault = memoryVault([entry({ [TEAM_FIELD]: 2 } as never)]);

    const [item] = await vaultEntriesAdapter(vault.port).list();

    expect(item).toEqual({ id: 'v1', teamId: 2, value: entry() });
  });

  it('adds an entry from another computer never used here and in no category', async () => {
    const vault = memoryVault();
    const { lastUsedAt: _used, categoryId: _category, ...shared } = entry();

    await vaultEntriesAdapter(vault.port).apply({ id: 'v1', teamId: 4, value: shared });

    const stored = vault.get()[0] as VaultEntry & Record<string, unknown>;
    expect(stored.lastUsedAt).toBeNull();
    expect(stored).not.toHaveProperty('categoryId');
    expect(stored[TEAM_FIELD]).toBe(4);
  });

  it('keeps this computer’s last use and category on an update', async () => {
    const vault = memoryVault([entry()]);

    await vaultEntriesAdapter(vault.port).apply({
      id: 'v1',
      teamId: null,
      value: { ...entry({ title: 'GitHub work', lastUsedAt: 50 }), categoryId: 'home' },
    });

    expect(vault.get()[0]).toMatchObject({
      title: 'GitHub work',
      lastUsedAt: 9,
      categoryId: 'work',
    });
  });

  it('removes an entry', async () => {
    const vault = memoryVault([entry()]);

    await vaultEntriesAdapter(vault.port).remove('v1');

    expect(vault.get()).toEqual([]);
  });

  it('names a kept copy within the title limit', () => {
    const copy = vaultEntriesAdapter(memoryVault().port).duplicate?.({ title: 'x'.repeat(200) });

    expect(String(copy?.title)).toHaveLength(200);
    expect(String(copy?.title)).toMatch(/\(from another computer\)$/);
  });
});
