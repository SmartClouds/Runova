import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
} from 'node:crypto';
import { canonicalSecret } from '@runova/protocol';
import type { PassphraseSecretEnvelope } from '../../shared/apiTypes';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;

function scrypt(passphrase: string, salt: string, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/**
 * An AES-256 key from a passphrase. `options` defaults to Node's scrypt cost (N = 16384).
 * A recovery phrase is read in its canonical form first (E107), so one typed with capitals or
 * extra spaces still opens what it locked. Any other passphrase is used exactly as typed.
 */
export function deriveKey(
  passphrase: string,
  salt: string,
  options: ScryptOptions = {},
): Promise<Buffer> {
  return scrypt(canonicalSecret(passphrase), salt, options);
}

/** `aad` is authenticated but not encrypted: decrypting fails unless the same bytes are given. */
export function encryptWithKey(
  plaintext: string,
  key: Buffer,
  aad?: Buffer,
): PassphraseSecretEnvelope {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return {
    mode: 'passphrase',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Throws when the key is wrong or the data was changed, since the GCM auth tag won't match. */
export function decryptWithKey(
  envelope: Omit<PassphraseSecretEnvelope, 'mode'> & { mode?: string },
  key: Buffer,
  aad?: Buffer,
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf-8');
}
