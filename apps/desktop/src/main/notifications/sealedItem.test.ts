import { createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sealItem, sealKeyId } from './sealedItem';

/**
 * The vectors the phone's Rust core replays, so the two sides can't drift apart unnoticed. Run with
 * UPDATE_VECTORS=1 to write the file after a deliberate change to the format.
 */
const here = dirname(fileURLToPath(import.meta.url));
const file = join(
  here,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'protocol',
  'test-vectors',
  'sealed-item-v1.json',
);

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** What the phone does with its identity seed, repeated here only to build the vectors. */
function recipientPublic(seed: Uint8Array): Buffer {
  const secret = Buffer.from(
    hkdfSync('sha256', seed, Buffer.alloc(0), 'runova-notification-key-v1', 32),
  );
  const key = createPublicKey(
    createPrivateKey({ key: Buffer.concat([PKCS8, secret]), format: 'der', type: 'pkcs8' }),
  );
  return Buffer.from(key.export({ format: 'jwk' }).x as string, 'base64url');
}

function caseOf(fill: number, text: string, context: string) {
  const seed = new Uint8Array(32).fill(fill);
  const ephemeralSecret = new Uint8Array(32).fill(fill + 1);
  const nonce = new Uint8Array(12).fill(fill + 2);
  const recipient = recipientPublic(seed);
  const plaintext = Buffer.from(text, 'utf8');
  return {
    identitySeed: hex(seed),
    recipientPublic: hex(recipient),
    keyId: sealKeyId(recipient),
    ephemeralSecret: hex(ephemeralSecret),
    nonce: hex(nonce),
    context,
    plaintext: hex(plaintext),
    sealed: hex(sealItem(recipient, plaintext, context, { ephemeralSecret, nonce })),
  };
}

function vectors() {
  return {
    version: 1,
    cases: [
      caseOf(0x31, 'Codex finished in Shop', 'notification:agent-finished'),
      caseOf(0x41, 'Déployé: 部署 failed in Café', 'notification:deploys'),
      caseOf(0x51, '', 'notification:tasks'),
    ],
  };
}

describe('sealed items', () => {
  it('match the committed vectors', () => {
    const expected = `${JSON.stringify(vectors(), null, 2)}\n`;
    if (process.env.UPDATE_VECTORS === '1' || !existsSync(file)) writeFileSync(file, expected);
    expect(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).toBe(expected);
  });

  it('never seals the same text the same way twice', () => {
    const recipient = recipientPublic(new Uint8Array(32).fill(7));
    const text = Buffer.from('hello');
    const first = sealItem(recipient, text, 'c');
    const second = sealItem(recipient, text, 'c');

    expect(first.equals(second)).toBe(false);
    expect(first.includes(text)).toBe(false);
  });

  it('adds a fixed overhead to what it seals', () => {
    const recipient = recipientPublic(new Uint8Array(32).fill(7));
    expect(sealItem(recipient, Buffer.alloc(10), 'c')).toHaveLength(1 + 32 + 12 + 10 + 16);
  });

  it('gives each key a short stable name', () => {
    const recipient = recipientPublic(new Uint8Array(32).fill(7));
    expect(sealKeyId(recipient)).toHaveLength(12);
    expect(sealKeyId(recipient)).toBe(sealKeyId(recipient));
  });
});
