import type { SecretPort } from '../adapters/arrayStore';

/** A sealed secret the way `memorySecrets` writes it, for building store items in tests. */
export function sealed(plain: string) {
  return { mode: 'safeStorage' as const, ciphertext: `sealed:${plain}` };
}

/**
 * Opens and seals like the OS keychain would, without it: the ciphertext is the plaintext with a
 * prefix, so a test can see what was sealed. `lock()` makes both throw, like a locked passkey.
 */
export function memorySecrets(): SecretPort & { lock: () => void } {
  let locked = false;
  return {
    open: (async (envelope: { ciphertext: string }) => {
      if (locked) throw new Error('The Servers vault is locked.');
      return envelope.ciphertext.replace(/^sealed:/, '');
    }) as SecretPort['open'],
    seal: async (plain: string) => {
      if (locked) throw new Error('The Servers vault is locked.');
      return sealed(plain);
    },
    lock: () => {
      locked = true;
    },
  };
}
