import { randomUUID } from 'node:crypto';
import type { EncryptionPolicy } from '@runova/core';
import { z } from 'zod';

/**
 * The Runova account this computer is signed in to (E48), in account.json. The refresh token and
 * every scope's data key are sealed with the OS keychain (safeStorage) and only ever opened in the
 * main process. With no keychain (Linux without a secret service) nothing secret is written: the
 * token and keys live in memory and the person signs in again next time. The device id names this
 * computer to the server and survives signing out. One write queue keeps two changes from losing
 * each other.
 */

export interface AccountIdentity {
  id: number;
  email: string;
  displayName: string;
}

export interface AccountStatePort {
  /** The parsed file, or null when there is none or it is not JSON. */
  read: () => Promise<unknown>;
  write: (value: AccountStateFile) => Promise<void>;
  canSeal: () => boolean;
  seal: (plain: string) => string;
  /** Throws when the text was not sealed by this computer's keychain. */
  open: (sealed: string) => string;
}

export interface AccountStateFile {
  version: 1;
  deviceId: string;
  account: AccountIdentity | null;
  sessionId: number | null;
  refreshToken: string | null;
  /** `suspended`: the server listed the scope with no key while this one was held. */
  keys: Record<string, { version: number; sealed: string; suspended?: boolean }>;
  /** The sealing policy pinned on this computer for each scope (see sync/engine.ts). */
  policies?: Record<string, EncryptionPolicy>;
}

export interface AccountSnapshot {
  deviceId: string;
  account: AccountIdentity | null;
  sessionId: number | null;
  /** False when the token lives in memory only, for lack of a keychain. */
  rememberedOnDisk: boolean;
}

const fileSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().uuid(),
  account: z
    .object({
      id: z.number().int().positive(),
      email: z.string().max(320),
      displayName: z.string().max(200),
    })
    .nullable(),
  sessionId: z.number().int().positive().nullable(),
  refreshToken: z.string().max(4096).nullable(),
  keys: z.record(
    z.string().regex(/^\d{1,18}$/),
    z.object({
      version: z.number().int().positive(),
      sealed: z.string().max(4096),
      suspended: z.boolean().optional(),
    }),
  ),
  policies: z
    .record(
      z.string().regex(/^\d{1,18}$/),
      z.object({ servers: z.boolean(), environments: z.boolean(), everything: z.boolean() }),
    )
    .optional(),
});

export function createAccountState(port: AccountStatePort) {
  let loaded: AccountStateFile | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  // Held here when the keychain can not keep them.
  let memoryToken: string | null = null;
  const memoryKeys = new Map<string, { version: number; key: Buffer; suspended?: boolean }>();

  async function load(): Promise<AccountStateFile> {
    if (loaded) return loaded;
    const raw = await port.read().catch(() => null);
    const parsed = fileSchema.safeParse(raw);
    if (parsed.success) {
      loaded = parsed.data;
    } else {
      // A file that is not valid is dropped, but a readable device id in it is kept.
      const deviceId = fileSchema.shape.deviceId.safeParse(
        (raw as { deviceId?: unknown } | null)?.deviceId,
      ).data;
      loaded = {
        version: 1,
        deviceId: deviceId ?? randomUUID(),
        account: null,
        sessionId: null,
        refreshToken: null,
        keys: {},
      };
      await port.write(loaded);
    }
    return loaded;
  }

  function mutate(change: (file: AccountStateFile) => void): Promise<void> {
    const next = queue.then(async () => {
      const file = await load();
      change(file);
      await port.write(file);
    });
    queue = next.catch(() => undefined);
    return next;
  }

  function tryOpen(sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      return port.open(sealed);
    } catch {
      return null;
    }
  }

  return {
    async snapshot(): Promise<AccountSnapshot> {
      const file = await load();
      return {
        deviceId: file.deviceId,
        account: file.account,
        sessionId: file.sessionId,
        rememberedOnDisk: port.canSeal(),
      };
    },

    signedIn(input: { account: AccountIdentity; sessionId: number; refreshToken: string }) {
      memoryToken = port.canSeal() ? null : input.refreshToken;
      return mutate((file) => {
        file.account = input.account;
        file.sessionId = input.sessionId;
        file.refreshToken = port.canSeal() ? port.seal(input.refreshToken) : null;
      });
    },

    rotated(refreshToken: string) {
      if (!port.canSeal()) {
        memoryToken = refreshToken;
        return Promise.resolve();
      }
      return mutate((file) => {
        file.refreshToken = port.seal(refreshToken);
      });
    },

    updateAccount(account: AccountIdentity) {
      return mutate((file) => {
        if (file.account) file.account = account;
      });
    },

    async refreshToken(): Promise<string | null> {
      if (memoryToken) return memoryToken;
      return tryOpen((await load()).refreshToken);
    },

    putKey(scopeId: number, version: number, key: Buffer) {
      const id = String(scopeId);
      if (!port.canSeal()) {
        memoryKeys.set(id, { version, key: Buffer.from(key) });
        return Promise.resolve();
      }
      return mutate((file) => {
        file.keys[id] = { version, sealed: port.seal(key.toString('base64')) };
      });
    },

    async key(
      scopeId: number,
    ): Promise<{ version: number; key: Buffer; suspended?: boolean } | null> {
      const id = String(scopeId);
      const inMemory = memoryKeys.get(id);
      if (inMemory) return inMemory;
      const stored = (await load()).keys[id];
      const opened = tryOpen(stored?.sealed ?? null);
      if (!stored || !opened) return null;
      const key = Buffer.from(opened, 'base64');
      if (key.length !== 32) return null;
      return stored.suspended
        ? { version: stored.version, key, suspended: true }
        : { version: stored.version, key };
    },

    /** The server listed the scope with no key: the key stays, marked until the next one. */
    suspendKey(scopeId: number) {
      const id = String(scopeId);
      const inMemory = memoryKeys.get(id);
      if (inMemory) {
        inMemory.suspended = true;
        return Promise.resolve();
      }
      return mutate((file) => {
        const stored = file.keys[id];
        if (stored) stored.suspended = true;
      });
    },

    forgetKey(scopeId: number) {
      memoryKeys.delete(String(scopeId));
      return mutate((file) => {
        delete file.keys[String(scopeId)];
      });
    },

    async pinnedPolicy(scopeId: number): Promise<EncryptionPolicy | null> {
      return (await load()).policies?.[String(scopeId)] ?? null;
    },

    pinPolicy(scopeId: number, policy: EncryptionPolicy) {
      return mutate((file) => {
        file.policies = { ...file.policies, [String(scopeId)]: { ...policy } };
      });
    },

    signedOut() {
      memoryToken = null;
      memoryKeys.clear();
      return mutate((file) => {
        file.account = null;
        file.sessionId = null;
        file.refreshToken = null;
        file.keys = {};
        delete file.policies;
      });
    },
  };
}

export type AccountState = ReturnType<typeof createAccountState>;
