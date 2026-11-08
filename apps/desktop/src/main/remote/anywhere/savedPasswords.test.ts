import { describe, expect, it } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import { createSavedPasswords } from './savedPasswords';

function deps(options: { locked?: () => boolean } = {}) {
  let file: unknown = null;
  let key = 'k1';
  return {
    io: {
      read: async () => file,
      write: async (value: unknown) => {
        file = JSON.parse(JSON.stringify(value));
      },
    },
    crypto: {
      encrypt: async (plain: string): Promise<SecretEnvelope> => {
        if (options.locked?.()) throw new Error('locked');
        return { mode: 'safeStorage', ciphertext: `${key}:${plain}` };
      },
      decrypt: async (envelope: SecretEnvelope): Promise<string> => {
        if (options.locked?.()) throw new Error('locked');
        const [k, plain] = envelope.ciphertext.split(':');
        if (k !== key) throw new Error('wrong key');
        return plain;
      },
    },
    file: () => file,
    rotate: (next: string) => {
      key = next;
    },
  };
}

describe('saved Anywhere passwords', () => {
  it('keeps the secret sealed in the vault, for the host key it works with', async () => {
    const d = deps();
    const saved = createSavedPasswords(d.io, d.crypto);
    const secret = new Uint8Array(32).fill(5);

    await saved.set('482193775', 'host-key', secret);

    expect(await saved.get('482193775', 'host-key')).toEqual(secret);
    expect(await saved.get('482193775', 'another-key')).toBeNull();
    expect(await saved.has('482193775')).toBe(true);
    const entry = (d.file() as { entries: Record<string, Record<string, unknown>> }).entries[
      '482193775'
    ];
    expect(Object.keys(entry).sort()).toEqual(['envelope', 'hostKey']);
    expect((entry.envelope as SecretEnvelope).ciphertext).toMatch(/^k1:/);
  });

  it('forgets a secret', async () => {
    const d = deps();
    const saved = createSavedPasswords(d.io, d.crypto);
    await saved.set('482193775', 'k', new Uint8Array(32));

    await saved.forget('482193775');

    expect(await saved.has('482193775')).toBe(false);
  });

  it('asks for the password again while the vault is locked', async () => {
    let locked = false;
    const d = deps({ locked: () => locked });
    const saved = createSavedPasswords(d.io, d.crypto);
    await saved.set('482193775', 'k', new Uint8Array(32));
    locked = true;

    expect(await saved.get('482193775', 'k')).toBeNull();
    await expect(saved.set('100000000', 'k', new Uint8Array(32))).resolves.toBeUndefined();
    expect(await saved.has('100000000')).toBe(false);
  });

  it('moves every secret when the vault passkey changes', async () => {
    const d = deps();
    const saved = createSavedPasswords(d.io, d.crypto);
    await saved.set('482193775', 'k', new Uint8Array(32).fill(9));

    const commit = await saved.sealed.prepare(async (envelope) => {
      const plain = await d.crypto.decrypt(envelope);
      d.rotate('k2');
      return d.crypto.encrypt(plain);
    });
    await commit();

    expect(await saved.get('482193775', 'k')).toEqual(new Uint8Array(32).fill(9));
  });
});
