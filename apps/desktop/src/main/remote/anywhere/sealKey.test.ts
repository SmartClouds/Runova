import { describe, expect, it, vi } from 'vitest';
import { createAnywhereStore, type TrustedPhone } from './settings';

function phone(key: string, change: Partial<TrustedPhone> = {}): TrustedPhone {
  return { key, name: key, platform: null, scopes: [], approvedAt: 1, lastSeenAt: 1, ...change };
}

function storeWith(phones: TrustedPhone[]) {
  const write = vi.fn(async () => undefined);
  const store = createAnywhereStore({
    read: async () => ({ version: 1, phones }),
    write,
    canSeal: () => false,
    seal: (plain) => plain,
    open: (sealed) => sealed,
  });
  return { store, write };
}

describe('a phone sealing key', () => {
  it('is kept against the phone that gave it', async () => {
    const { store } = storeWith([phone('a'), phone('b')]);

    await store.setPhoneSealKey('a', 'public-a');

    const phones = await store.phones();
    expect(phones.find((p) => p.key === 'a')?.sealKey).toBe('public-a');
    expect(phones.find((p) => p.key === 'b')?.sealKey).toBeUndefined();
  });

  it('writes nothing when it has not changed', async () => {
    const { store, write } = storeWith([phone('a', { sealKey: 'same' })]);

    await store.setPhoneSealKey('a', 'same');

    expect(write).not.toHaveBeenCalled();
  });

  it('can be replaced', async () => {
    const { store } = storeWith([phone('a', { sealKey: 'old' })]);

    await store.setPhoneSealKey('a', 'new');

    expect((await store.phones())[0]?.sealKey).toBe('new');
  });

  it('is ignored for a phone this computer has not approved', async () => {
    const { store, write } = storeWith([phone('a')]);

    await store.setPhoneSealKey('stranger', 'public');

    expect(write).not.toHaveBeenCalled();
    expect(await store.phones()).toHaveLength(1);
  });
});
