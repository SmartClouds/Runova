import { MANAGE_METHODS } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ManageError } from './session';
import { type ManageVaultDeps, vaultMethods } from './vaultMethods';

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['vault' as const] } };

const summary = {
  id: 'e1',
  type: 'login',
  title: 'GitHub',
  tags: ['work'],
  favorite: true,
  createdAt: 1,
  updatedAt: 2,
  lastUsedAt: null,
  username: 'sam',
  service: '',
  keyId: '',
  urls: ['https://github.com'],
  host: 'github.com',
  icon: 'data:image/png;base64,AAAA',
  categoryId: null,
  autoSubmit: false,
  hasPassword: true,
  hasTotp: false,
  hasSecret: false,
  hasNotes: true,
  passwordUpdatedAt: 5,
  expiresAt: null,
  fields: [{ id: 'f1', label: 'PIN', concealed: true, hasValue: true }],
} as const;

function deps(change: Partial<ManageVaultDeps> = {}): ManageVaultDeps {
  return {
    status: async () => ({
      state: 'unlocked',
      retryAfterMs: 0,
      autoLockMinutes: 15,
      clipboardClearSeconds: 30,
    }),
    unlock: async () => ({ ok: true }),
    lock: async () => undefined,
    list: () => [summary as never],
    reveal: () => 'hunter2',
    save: async () => summary as never,
    remove: async () => 1,
    ...change,
  };
}

function call(d: ManageVaultDeps, method: string, params?: unknown) {
  return vaultMethods(d)[method](params, context);
}

describe('vault methods', () => {
  it('says whether it is locked and nothing about its settings', async () => {
    await expect(call(deps(), 'vault.status')).resolves.toEqual({
      state: 'unlocked',
      retryAfterMs: 0,
    });
  });

  it('passes the unlock result on', async () => {
    const unlock = vi.fn(async () => ({
      ok: false as const,
      reason: 'wrong-password' as const,
      retryAfterMs: 1000,
    }));

    await expect(call(deps({ unlock }), 'vault.unlock', { password: 'nope' })).resolves.toEqual({
      ok: false,
      reason: 'wrong-password',
      retryAfterMs: 1000,
    });
    expect(unlock).toHaveBeenCalledWith('nope');
  });

  it('needs a password to unlock', async () => {
    await expect(call(deps(), 'vault.unlock', {})).rejects.toBeInstanceOf(ManageError);
  });

  it('lists entries from an allowlist, with no secrets or pictures', async () => {
    const [entry] = (await call(deps(), 'vault.list')) as Record<string, unknown>[];

    expect(entry).toEqual({
      id: 'e1',
      type: 'login',
      title: 'GitHub',
      username: 'sam',
      service: '',
      host: 'github.com',
      favorite: true,
      hasPassword: true,
      hasTotp: false,
      hasSecret: false,
      hasNotes: true,
      fields: [{ id: 'f1', label: 'PIN', concealed: true, hasValue: true }],
    });
  });

  it('reveals one named field', async () => {
    const reveal = vi.fn(() => 'hunter2');

    await expect(
      call(deps({ reveal }), 'vault.reveal', { id: 'e1', field: 'password' }),
    ).resolves.toEqual({ value: 'hunter2' });
    expect(reveal).toHaveBeenCalledWith('e1', 'password');
  });

  it('reveals a custom field by its id', async () => {
    const reveal = vi.fn(() => '1234');

    await call(deps({ reveal }), 'vault.reveal', { id: 'e1', field: { customFieldId: 'f1' } });

    expect(reveal).toHaveBeenCalledWith('e1', { customFieldId: 'f1' });
  });

  it('refuses a field it does not know', async () => {
    await expect(
      call(deps(), 'vault.reveal', { id: 'e1', field: 'constructor' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('turns the vault being locked into a message for the phone', async () => {
    const locked = Object.assign(new Error('The vault is locked.'), { name: 'VaultError' });
    const reveal = () => {
      throw locked;
    };

    await expect(
      call(deps({ reveal }), 'vault.reveal', { id: 'e1', field: 'password' }),
    ).rejects.toMatchObject({ code: 'failed', message: 'The vault is locked.' });
  });

  it('keeps tags and favorite when an entry is edited, and leaves the password alone unless sent', async () => {
    const save = vi.fn(async () => summary as never);

    await call(deps({ save }), 'vault.save', { id: 'e1', title: 'GitHub 2', username: 'sammy' });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'e1',
        type: 'login',
        title: 'GitHub 2',
        username: 'sammy',
        tags: ['work'],
        favorite: true,
      }),
    );
    expect(save.mock.calls[0]).not.toHaveProperty('0.password');
  });

  it('creates a new login with no id', async () => {
    const save = vi.fn(async () => summary as never);

    await call(deps({ save }), 'vault.save', { title: 'New', password: 'pw' });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'login', title: 'New', password: 'pw', tags: [] }),
    );
  });

  it('does not touch an entry type the phone cannot edit', async () => {
    const custom = { ...summary, type: 'custom' } as never;

    await expect(
      call(deps({ list: () => [custom] }), 'vault.save', { id: 'e1', title: 'x' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('removes one entry', async () => {
    const remove = vi.fn(async () => 1);

    await call(deps({ remove }), 'vault.remove', { id: 'e1' });

    expect(remove).toHaveBeenCalledWith('e1');
  });

  it('files reveal, remove and save as risky, so each one is audited', () => {
    expect(MANAGE_METHODS['vault.reveal'].risk).toBe('danger');
    expect(MANAGE_METHODS['vault.remove'].risk).toBe('danger');
    expect(MANAGE_METHODS['vault.save'].risk).toBe('write');
    for (const [name, method] of Object.entries(MANAGE_METHODS)) {
      if (name.startsWith('vault.')) expect(method.scope).toBe('vault');
    }
  });

  it('runs every method the protocol names for the vault', () => {
    const named = Object.keys(MANAGE_METHODS).filter((name) => name.startsWith('vault.'));

    expect(Object.keys(vaultMethods(deps())).sort()).toEqual(named.sort());
  });
});
