import type { SaveVaultEntryInput, VaultEntrySummary, VaultFieldRef } from '@runova/core';
import type { ManageVaultEntry } from '@runova/protocol';
import type { VaultStatus, VaultUnlockResult } from '../../../shared/apiTypes';
import { ManageError, type ManageMethods } from './session';

export interface ManageVaultDeps {
  status(): Promise<VaultStatus>;
  unlock(password: string): Promise<VaultUnlockResult>;
  lock(): Promise<void>;
  list(): VaultEntrySummary[];
  reveal(id: string, field: VaultFieldRef): string;
  save(input: SaveVaultEntryInput): Promise<VaultEntrySummary>;
  remove(id: string): Promise<number>;
}

const NAMED_FIELDS = new Set(['username', 'password', 'totpSecret', 'secret', 'keyId', 'notes']);

function text(params: unknown, name: string, say: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[name];
  if (typeof value !== 'string' || value.length === 0) throw new ManageError('bad-params', say);
  return value;
}

function optional(params: unknown, name: string): string | undefined {
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function fieldRef(params: unknown): VaultFieldRef {
  const field = (params as { field?: unknown } | null | undefined)?.field;
  if (typeof field === 'string' && NAMED_FIELDS.has(field)) return field as VaultFieldRef;
  const custom = (field as { customFieldId?: unknown } | null | undefined)?.customFieldId;
  if (typeof custom === 'string' && custom.length > 0) return { customFieldId: custom };
  throw new ManageError('bad-params', 'Say which field.');
}

/** Field by field, so a secret added to the summary later can't reach a phone by default. */
function entryOf(entry: VaultEntrySummary): ManageVaultEntry {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    username: entry.username,
    service: entry.service,
    host: entry.host,
    favorite: entry.favorite,
    hasPassword: entry.hasPassword,
    hasTotp: entry.hasTotp,
    hasSecret: entry.hasSecret,
    hasNotes: entry.hasNotes,
    fields: entry.fields.map(({ id, label, concealed, hasValue }) => ({
      id,
      label,
      concealed,
      hasValue,
    })),
  };
}

/** The vault's own messages are written for people. Anything else stays on the computer. */
async function guarded<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ManageError) throw error;
    if ((error as Error).name === 'VaultError') {
      throw new ManageError('failed', (error as Error).message);
    }
    throw error;
  }
}

function saveInput(params: unknown, deps: ManageVaultDeps): SaveVaultEntryInput {
  const id = optional(params, 'id');
  const title = text(params, 'title', 'Give it a title.');
  const username = optional(params, 'username');
  const password = optional(params, 'password');
  if (!id) return { type: 'login', title, tags: [], favorite: false, username, password };
  const existing = deps.list().find((entry) => entry.id === id);
  if (!existing) throw new ManageError('bad-params', 'That entry is gone.');
  if (existing.type !== 'login') {
    throw new ManageError('bad-params', 'Edit this kind of entry on the computer.');
  }
  return {
    id,
    type: 'login',
    title,
    tags: existing.tags,
    favorite: existing.favorite,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}

export function vaultMethods(deps: ManageVaultDeps): ManageMethods['calls'] {
  return {
    'vault.status': async () => {
      const { state, retryAfterMs } = await deps.status();
      return { state, retryAfterMs };
    },
    'vault.unlock': (params) =>
      guarded(() => deps.unlock(text(params, 'password', 'Enter the vault password.'))),
    'vault.lock': () => guarded(() => deps.lock()),
    'vault.list': () => guarded(() => deps.list().map(entryOf)),
    'vault.reveal': (params) =>
      guarded(() => ({
        value: deps.reveal(text(params, 'id', 'Say which entry.'), fieldRef(params)),
      })),
    'vault.save': (params) =>
      guarded(async () => entryOf(await deps.save(saveInput(params, deps)))),
    'vault.remove': (params) => guarded(() => deps.remove(text(params, 'id', 'Say which entry.'))),
  };
}
