import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';

/**
 * Seals a short item so only one phone can read it, with nothing shared in advance beyond that
 * phone's public key. A fresh X25519 key is made for every item, so the computer can't open what
 * it sealed earlier and the server never holds anything that could.
 *
 * Bytes: 0x01, the fresh public key (32), the nonce (12), then AES-256-GCM ciphertext and tag.
 * The phone's side lives in the Rust core, and both replay `sealed-item-v1.json`.
 */
const VERSION = 1;
const INFO = 'runova-sealed-item-v1';
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface SealRandomness {
  ephemeralSecret: Uint8Array;
  nonce: Uint8Array;
}

function privateKeyOf(secret: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, secret]),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicBytes(key: KeyObject): Buffer {
  const { x } = key.export({ format: 'jwk' });
  return Buffer.from(x as string, 'base64url');
}

function publicKeyOf(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}

function freshEphemeral(): KeyObject {
  return generateKeyPairSync('x25519').privateKey;
}

/** The short name a key goes by, so the server can hand each phone its own copy. */
export function sealKeyId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest().subarray(0, 9).toString('base64url');
}

export function sealItem(
  recipient: Uint8Array,
  plaintext: Uint8Array,
  context: string,
  randomness?: SealRandomness,
): Buffer {
  const ephemeral = randomness ? privateKeyOf(randomness.ephemeralSecret) : freshEphemeral();
  const ephemeralPublic = publicBytes(createPublicKey(ephemeral));
  const shared = diffieHellman({ privateKey: ephemeral, publicKey: publicKeyOf(recipient) });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, recipient]), INFO, 32),
  );
  const nonce = randomness ? Buffer.from(randomness.nonce) : randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), ephemeralPublic, nonce, body, cipher.getAuthTag()]);
}
