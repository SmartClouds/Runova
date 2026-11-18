import { randomBytes, type ScryptOptions } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptWithKey, deriveKey, encryptWithKey } from './aesGcm';

/**
 * scrypt at the app's real cost takes a noticeable fraction of a second per call, which is the
 * point in production and dead weight here. Every derivation in this file uses the cheapest
 * parameters that still exercise the same code path.
 */
const CHEAP: ScryptOptions = { N: 1024, r: 8, p: 1 };

/** Flips one bit of a base64 field, the smallest change GCM has to notice. */
function tamper(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

describe('aesGcm', () => {
  const key = randomBytes(32);

  it('round-trips text and uses a fresh IV every time', () => {
    const first = encryptWithKey('hello', key);
    const second = encryptWithKey('hello', key);
    expect(first.iv).not.toBe(second.iv);
    expect(decryptWithKey(first, key)).toBe('hello');
  });

  it('rejects a wrong key', () => {
    const envelope = encryptWithKey('hello', key);
    expect(() => decryptWithKey(envelope, randomBytes(32))).toThrow();
  });

  it('binds additional authenticated data when given', () => {
    const aad = Buffer.from('header-v1');
    const envelope = encryptWithKey('hello', key, aad);
    expect(decryptWithKey(envelope, key, aad)).toBe('hello');
    expect(() => decryptWithKey(envelope, key, Buffer.from('header-v2'))).toThrow();
    expect(() => decryptWithKey(envelope, key)).toThrow();
  });

  it('still opens envelopes written without AAD, so existing callers keep working', () => {
    const envelope = encryptWithKey('legacy', key);
    expect(decryptWithKey(envelope, key)).toBe('legacy');
  });

  // Secrets here are pasted by hand: an API key with a trailing newline, a note in another
  // script, or an empty field the user cleared. Every one has to come back byte for byte.
  it.each([
    ['unicode', 'pässwörd 漢字 \u{1f510} رمز'],
    ['empty string', ''],
    ['newlines and tabs', 'line one\r\nline two\tend\n'],
    ['a value longer than one AES block', 'x'.repeat(5000)],
  ])('round-trips %s', (_label, plaintext) => {
    const envelope = encryptWithKey(plaintext, key);
    expect(decryptWithKey(envelope, key)).toBe(plaintext);
  });

  it('writes an envelope the shape the store expects', () => {
    const envelope = encryptWithKey('hello', key);
    expect(envelope.mode).toBe('passphrase');
    // 12-byte IV and 16-byte tag: anything else means the cipher was reconfigured.
    expect(Buffer.from(envelope.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(envelope.authTag, 'base64')).toHaveLength(16);
    expect(envelope.ciphertext).not.toContain('hello');
  });

  // A backup file or a JSON store on disk can be edited by anything with write access, so each
  // of the three fields has to be covered by the tag rather than just the ciphertext.
  describe('rejects a tampered envelope', () => {
    it.each(['iv', 'authTag', 'ciphertext'] as const)('when %s was changed', (field) => {
      const envelope = encryptWithKey('secret value', key);
      expect(() =>
        decryptWithKey({ ...envelope, [field]: tamper(envelope[field]) }, key),
      ).toThrow();
    });

    it('when a byte was appended to the ciphertext', () => {
      const envelope = encryptWithKey('secret value', key);
      const longer = Buffer.concat([Buffer.from(envelope.ciphertext, 'base64'), Buffer.from([0])]);
      expect(() =>
        decryptWithKey({ ...envelope, ciphertext: longer.toString('base64') }, key),
      ).toThrow();
    });
  });
});

describe('deriveKey', () => {
  it('gives the same 32-byte key for the same passphrase and salt', async () => {
    const [first, second] = await Promise.all([
      deriveKey('correct horse', 'c2FsdC1vbmU=', CHEAP),
      deriveKey('correct horse', 'c2FsdC1vbmU=', CHEAP),
    ]);
    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
  });

  it('gives a different key for a different salt, so two vaults never share one', async () => {
    const [first, second] = await Promise.all([
      deriveKey('correct horse', 'c2FsdC1vbmU=', CHEAP),
      deriveKey('correct horse', 'c2FsdC10d28=', CHEAP),
    ]);
    expect(first.equals(second)).toBe(false);
  });

  it('gives a different key for a different passphrase', async () => {
    const [first, second] = await Promise.all([
      deriveKey('correct horse', 'c2FsdC1vbmU=', CHEAP),
      deriveKey('correct hors', 'c2FsdC1vbmU=', CHEAP),
    ]);
    expect(first.equals(second)).toBe(false);
  });

  it('gives a different key for a different cost, so a re-derived key needs the stored N', async () => {
    const [cheap, dearer] = await Promise.all([
      deriveKey('correct horse', 'c2FsdC1vbmU=', CHEAP),
      deriveKey('correct horse', 'c2FsdC1vbmU=', { ...CHEAP, N: 2048 }),
    ]);
    expect(cheap.equals(dearer)).toBe(false);
  });

  it('produces a key the cipher accepts, and the wrong passphrase does not open it', async () => {
    const salt = 'c2FsdC1yb3VuZA==';
    const key = await deriveKey('opensesame', salt, CHEAP);
    const envelope = encryptWithKey('a secret', key);
    expect(decryptWithKey(envelope, await deriveKey('opensesame', salt, CHEAP))).toBe('a secret');
    const wrong = await deriveKey('opensesam', salt, CHEAP);
    expect(() => decryptWithKey(envelope, wrong)).toThrow();
  });

  it('gives a recovery phrase the same key however it was typed (E107)', async () => {
    const salt = 'cGhyYXNl';
    const phrase = `${'zoo '.repeat(23)}vote`;
    const typed = `  ${'ZOO	'.repeat(23)}Vote
`;
    expect((await deriveKey(typed, salt, CHEAP)).equals(await deriveKey(phrase, salt, CHEAP))).toBe(
      true,
    );
  });

  it('uses a passphrase exactly as typed, spaces and capitals included', async () => {
    const salt = 'cGhyYXNl';
    const plain = await deriveKey('Open Sesame', salt, CHEAP);
    expect(plain.equals(await deriveKey('open sesame', salt, CHEAP))).toBe(false);
    expect(plain.equals(await deriveKey('Open  Sesame', salt, CHEAP))).toBe(false);
  });
});
