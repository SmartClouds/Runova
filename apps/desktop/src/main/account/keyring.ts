import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  DEFAULT_VAULT_KDF_COST,
  deriveVaultKey,
  isKdfWithinBounds,
  type KdfCost,
  newKdfParams,
  type VaultKdfParams,
} from '../vault/kdf';

/**
 * End-to-end encryption for synced data (E48). Each scope (an account or a team) has a data key:
 * 32 random bytes. The server keeps it only wrapped, twice: by a key scrypt derives from the
 * passphrase (the Vault's cost), and by a recovery key shown to the person once. Records are
 * AES-256-GCM under the data key, with the scope, collection, item id and key version as
 * authenticated data, so a record can not be moved to another item or scope without failing.
 * Nothing here ever leaves the main process.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const RECORD_FORMAT = 'v1';
const KEY_FORMAT = 'runova-sync-key';

export interface WrappedKey {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface PassphraseWrap extends WrappedKey {
  kdf: VaultKdfParams;
}

export interface RecoveryWrap extends WrappedKey {
  /** Base64 of 32 random bytes for HKDF. */
  salt: string;
}

/** What the server stores for a scope. It can not open any of it. */
export interface KeyEnvelope {
  version: number;
  passphrase: PassphraseWrap;
  recovery: RecoveryWrap;
}

export interface MadeKey {
  key: Buffer;
  envelope: KeyEnvelope;
  /** Shown once, for the person to keep. */
  recoveryKey: string;
}

export interface RecordPlace {
  scopeId: number;
  collection: string;
  itemId: string;
  keyVersion: number;
}

function wrapAad(scopeId: number, version: number, how: 'passphrase' | 'recovery'): Buffer {
  return Buffer.from(`${KEY_FORMAT}|${scopeId}|${version}|${how}`, 'utf-8');
}

function recordAad(place: RecordPlace): Buffer {
  return Buffer.from(
    `runova-sync|${place.scopeId}|${place.collection}|${place.itemId}|${place.keyVersion}`,
    'utf-8',
  );
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): WrappedKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decrypt(key: Buffer, wrapped: WrappedKey, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrapped.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(wrapped.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

function recoveryKek(recovery: Buffer, salt: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', recovery, Buffer.from(salt, 'base64'), KEY_FORMAT, KEY_BYTES),
  );
}

async function wrapWithPassphrase(
  key: Buffer,
  passphrase: string,
  scopeId: number,
  version: number,
  cost: KdfCost,
): Promise<PassphraseWrap> {
  const kdf = newKdfParams(cost);
  const kek = await deriveVaultKey(passphrase, kdf);
  return { kdf, ...encrypt(kek, key, wrapAad(scopeId, version, 'passphrase')) };
}

function wrapWithRecovery(
  key: Buffer,
  recovery: Buffer,
  scopeId: number,
  version: number,
): RecoveryWrap {
  const salt = randomBytes(32).toString('base64');
  return {
    salt,
    ...encrypt(recoveryKek(recovery, salt), key, wrapAad(scopeId, version, 'recovery')),
  };
}

async function makeKey(
  scopeId: number,
  passphrase: string,
  version: number,
  cost: KdfCost,
): Promise<MadeKey> {
  const key = randomBytes(KEY_BYTES);
  const recovery = randomBytes(KEY_BYTES);
  const envelope: KeyEnvelope = {
    version,
    passphrase: await wrapWithPassphrase(key, passphrase, scopeId, version, cost),
    recovery: wrapWithRecovery(key, recovery, scopeId, version),
  };
  return { key, envelope, recoveryKey: formatRecoveryKey(recovery) };
}

export function createScopeKey(input: {
  scopeId: number;
  passphrase: string;
  cost?: KdfCost;
}): Promise<MadeKey> {
  return makeKey(input.scopeId, input.passphrase, 1, input.cost ?? DEFAULT_VAULT_KDF_COST);
}

/** A new key, for after someone left a team. Records are sealed again under it by the sync engine. */
export function rotateScopeKey(input: {
  scopeId: number;
  passphrase: string;
  previous: KeyEnvelope;
  cost?: KdfCost;
}): Promise<MadeKey> {
  return makeKey(
    input.scopeId,
    input.passphrase,
    input.previous.version + 1,
    input.cost ?? DEFAULT_VAULT_KDF_COST,
  );
}

export async function unwrapWithPassphrase(
  envelope: KeyEnvelope,
  passphrase: string,
  scopeId: number,
): Promise<Buffer> {
  if (!isKdfWithinBounds(envelope.passphrase.kdf)) {
    throw new Error('The key settings from the server are out of range.');
  }
  const kek = await deriveVaultKey(passphrase, envelope.passphrase.kdf);
  try {
    return decrypt(kek, envelope.passphrase, wrapAad(scopeId, envelope.version, 'passphrase'));
  } catch {
    throw new Error('That passphrase is not right.');
  }
}

export async function unwrapWithRecoveryKey(
  envelope: KeyEnvelope,
  recoveryKey: string,
  scopeId: number,
): Promise<Buffer> {
  const recovery = parseRecoveryKey(recoveryKey);
  if (!recovery)
    throw new Error('That is not a recovery key. It has eight groups of seven characters.');
  try {
    return decrypt(
      recoveryKek(recovery, envelope.recovery.salt),
      envelope.recovery,
      wrapAad(scopeId, envelope.version, 'recovery'),
    );
  } catch {
    throw new Error('That recovery key is not right.');
  }
}

/** The same key behind a new passphrase. The recovery key keeps working. */
export async function rewrapWithPassphrase(
  envelope: KeyEnvelope,
  key: Buffer,
  passphrase: string,
  scopeId: number,
  cost: KdfCost = DEFAULT_VAULT_KDF_COST,
): Promise<KeyEnvelope> {
  return {
    ...envelope,
    passphrase: await wrapWithPassphrase(key, passphrase, scopeId, envelope.version, cost),
  };
}

export function sealRecord(key: Buffer, place: RecordPlace, value: unknown): string {
  const sealed = encrypt(key, Buffer.from(JSON.stringify(value), 'utf-8'), recordAad(place));
  return [RECORD_FORMAT, sealed.iv, sealed.authTag, sealed.ciphertext].join('.');
}

/** Throws when the key is wrong, the record was changed, or it belongs somewhere else. */
export function openRecord(key: Buffer, place: RecordPlace, sealed: string): unknown {
  const [format, iv, authTag, ciphertext] = sealed.split('.');
  if (format !== RECORD_FORMAT || !iv || !authTag || !ciphertext) {
    throw new Error('Not a sealed record.');
  }
  return JSON.parse(decrypt(key, { iv, authTag, ciphertext }, recordAad(place)).toString('utf-8'));
}

// Crockford base32: no I, L, O or U, so a key read aloud or copied by hand is hard to get wrong.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 8;
const GROUP_LENGTH = 7;

export function formatRecoveryKey(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) text += ALPHABET[(value << (5 - bits)) & 31];
  text = text.padEnd(GROUPS * GROUP_LENGTH, '0');
  return Array.from({ length: GROUPS }, (_, i) =>
    text.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH),
  ).join('-');
}

export function parseRecoveryKey(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== GROUPS * GROUP_LENGTH || /[^0-9A-HJKMNP-TV-Z]/.test(clean)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return bytes.length >= KEY_BYTES ? Buffer.from(bytes.slice(0, KEY_BYTES)) : null;
}

function isWrapped(value: unknown): value is WrappedKey {
  const w = value as WrappedKey;
  return (
    !!w &&
    typeof w.iv === 'string' &&
    typeof w.authTag === 'string' &&
    typeof w.ciphertext === 'string'
  );
}

export function isKeyEnvelope(value: unknown): value is KeyEnvelope {
  const e = value as KeyEnvelope;
  return (
    !!e &&
    Number.isInteger(e.version) &&
    e.version >= 1 &&
    isWrapped(e.passphrase) &&
    !!e.passphrase.kdf &&
    isWrapped(e.recovery) &&
    typeof e.recovery.salt === 'string'
  );
}
