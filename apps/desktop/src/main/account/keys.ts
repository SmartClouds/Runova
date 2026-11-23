import { estimateStrength } from '@runova/core';
import { isValidPhrase } from '@runova/protocol';
import type { KdfCost } from '../vault/kdf';
import {
  createScopeKey,
  type KeyEnvelope,
  rewrapWithPassphrase,
  rotateScopeKey,
  unwrapWithPassphrase,
  unwrapWithRecoveryKey,
} from './keyring';
import type { AccountState } from './state';

/**
 * The end-to-end keys of the scopes this computer syncs (E48.12): setting one, opening one on a
 * second computer with the passphrase or the recovery key, a new passphrase, a new key after
 * someone left a team, and forgetting one the server reset. The passphrase never leaves the main
 * process, and the server only ever gets the wrapped key.
 */

export const PASSPHRASE_MIN_LENGTH = 12;

export interface KeyApi {
  key: (scopeId: number) => Promise<{ version: number; envelope: KeyEnvelope } | null>;
  putKey: (scopeId: number, version: number, envelope: KeyEnvelope) => Promise<void>;
  resetKey: (scopeId: number, stepUp: { password?: string; code?: string }) => Promise<void>;
}

/** Why a passphrase is not good enough, or null. */
export function passphraseProblem(passphrase: string): string | null {
  if (isValidPhrase(passphrase)) return null;
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) {
    return `Use at least ${PASSPHRASE_MIN_LENGTH} characters. A few unrelated words work well.`;
  }
  if (estimateStrength(passphrase).score < 3) {
    return 'That passphrase is too easy to guess. Add more words or make it longer.';
  }
  return null;
}

export function createKeyService(deps: { api: KeyApi; state: AccountState; cost?: KdfCost }) {
  const cost = deps.cost ? { cost: deps.cost } : {};

  return {
    /** The key this computer holds for a scope, if it holds one. */
    key: (scopeId: number) => deps.state.key(scopeId),

    async setKey(scopeId: number, passphrase: string): Promise<{ recoveryKey: string }> {
      const problem = passphraseProblem(passphrase);
      if (problem) throw new Error(problem);
      const made = await createScopeKey({ scopeId, passphrase, ...cost });
      await deps.api.putKey(scopeId, made.envelope.version, made.envelope);
      await deps.state.putKey(scopeId, made.envelope.version, made.key);
      return { recoveryKey: made.recoveryKey };
    },

    async unlock(
      scopeId: number,
      secret: { passphrase?: string; recoveryKey?: string },
    ): Promise<void> {
      const stored = await deps.api.key(scopeId);
      if (!stored) throw new Error('This has no key yet. Set one first.');
      const key = secret.recoveryKey
        ? await unwrapWithRecoveryKey(stored.envelope, secret.recoveryKey, scopeId)
        : await unwrapWithPassphrase(stored.envelope, secret.passphrase ?? '', scopeId);
      await deps.state.putKey(scopeId, stored.version, key);
    },

    async changePassphrase(scopeId: number, passphrase: string): Promise<void> {
      const problem = passphraseProblem(passphrase);
      if (problem) throw new Error(problem);
      const stored = await deps.api.key(scopeId);
      const held = await deps.state.key(scopeId);
      if (!stored || !held || held.version !== stored.version) {
        throw new Error('Unlock the key on this computer first.');
      }
      const envelope = await rewrapWithPassphrase(
        stored.envelope,
        held.key,
        passphrase,
        scopeId,
        deps.cost,
      );
      await deps.api.putKey(scopeId, stored.version, envelope);
    },

    /** A new key; the sync engine seals the scope's records again under it on its next run. */
    async rotate(scopeId: number, passphrase: string): Promise<{ recoveryKey: string }> {
      const problem = passphraseProblem(passphrase);
      if (problem) throw new Error(problem);
      const stored = await deps.api.key(scopeId);
      if (!stored) throw new Error('This has no key yet. Set one first.');
      const made = await rotateScopeKey({
        scopeId,
        passphrase,
        previous: stored.envelope,
        ...cost,
      });
      await deps.api.putKey(scopeId, made.envelope.version, made.envelope);
      await deps.state.putKey(scopeId, made.envelope.version, made.key);
      return { recoveryKey: made.recoveryKey };
    },

    async reset(scopeId: number, stepUp: { password?: string; code?: string }): Promise<void> {
      await deps.api.resetKey(scopeId, stepUp);
      await deps.state.forgetKey(scopeId);
    },

    /**
     * Drops a key the server moved past: rotated elsewhere to a newer version, or reset and set
     * again. A scope listed with no key, or an older one, does not drop it: the server alone can
     * not make this computer let go of its key (and so seal less). After a reset the next key
     * starts at version 1 again, so a key held through a listing with no key is dropped once the
     * server lists any key.
     */
    async forgetIfStale(scopeId: number, serverVersion: number | null): Promise<void> {
      const held = await deps.state.key(scopeId);
      if (!held) return;
      if (serverVersion === null) {
        if (!held.suspended) await deps.state.suspendKey(scopeId);
      } else if (serverVersion > held.version || held.suspended) {
        await deps.state.forgetKey(scopeId);
      }
    },
  };
}

export type KeyService = ReturnType<typeof createKeyService>;
