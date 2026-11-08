import { b64u, fromB64u } from '@runova/protocol';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type { SealedSecretStore } from '../../ssh/vault';
import type { SavedPasswords } from './service';

interface SavedFile {
  version: 1;
  /** By Runova ID: the host key the secret works with, and the secret sealed by the vault. */
  entries: Record<string, { hostKey: string; envelope: SecretEnvelope }>;
}

/**
 * Passwords saved for other computers (E61), in `anywhere-saved.json`. What is kept is the secret
 * derived from the password and the host's key, never the password: it only opens that one
 * computer, and it can not be turned back into the password. It is sealed by the Servers vault,
 * like a saved RDP password, so a vault passkey covers it too; while the vault is locked, Runova
 * asks for the password instead.
 */
export function createSavedPasswords(
  io: { read(): Promise<unknown>; write(value: unknown): Promise<void> },
  crypto: {
    encrypt(plain: string): Promise<SecretEnvelope>;
    decrypt(envelope: SecretEnvelope): Promise<string>;
  },
): SavedPasswords & { sealed: SealedSecretStore } {
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<SavedFile> {
    const raw = (await io.read()) as SavedFile | null;
    return raw && raw.version === 1 && raw.entries && typeof raw.entries === 'object'
      ? raw
      : { version: 1, entries: {} };
  }

  function change(apply: (file: SavedFile) => Promise<void> | void): Promise<void> {
    const run = queue.then(async () => {
      const file = await load();
      await apply(file);
      await io.write(file);
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    async get(remoteId, hostKey) {
      const entry = (await load()).entries[remoteId];
      if (!entry || entry.hostKey !== hostKey) return null;
      try {
        return fromB64u(await crypto.decrypt(entry.envelope));
      } catch {
        return null;
      }
    },

    async has(remoteId) {
      return Boolean((await load()).entries[remoteId]);
    },

    async set(remoteId, hostKey, secret) {
      let envelope: SecretEnvelope;
      try {
        envelope = await crypto.encrypt(b64u(secret));
      } catch {
        // The vault is locked: nothing is saved, and the person types it next time.
        return;
      }
      await change((file) => {
        file.entries[remoteId] = { hostKey, envelope };
      });
    },

    forget(remoteId) {
      return change((file) => {
        delete file.entries[remoteId];
      });
    },

    sealed: {
      async prepare(move) {
        const before = await load();
        const moved = new Map<string, { from: string; to: SecretEnvelope }>();
        for (const [remoteId, entry] of Object.entries(before.entries)) {
          moved.set(remoteId, { from: entry.envelope.ciphertext, to: await move(entry.envelope) });
        }
        return () =>
          change(async (file) => {
            for (const [remoteId, entry] of Object.entries(file.entries)) {
              const prepared = moved.get(remoteId);
              if (prepared && prepared.from === entry.envelope.ciphertext) {
                entry.envelope = prepared.to;
                continue;
              }
              try {
                entry.envelope = await move(entry.envelope);
              } catch {
                delete file.entries[remoteId];
              }
            }
          });
      },
    },
  };
}
