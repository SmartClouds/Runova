import { describe, expect, it } from 'vitest';
import {
  createScopeKey,
  formatRecoveryKey,
  isKeyEnvelope,
  openRecord,
  parseRecoveryKey,
  rewrapWithPassphrase,
  rotateScopeKey,
  sealRecord,
  unwrapWithPassphrase,
  unwrapWithRecoveryKey,
} from './keyring';

// Cheap scrypt so the suite stays fast; the real cost is the Vault's.
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';

describe('scope keys', () => {
  it('unwraps with the passphrase it was made with', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });

    const key = await unwrapWithPassphrase(made.envelope, PASS, 7);

    expect(key.equals(made.key)).toBe(true);
    expect(made.key).toHaveLength(32);
    expect(made.envelope.version).toBe(1);
  });

  it('refuses a wrong passphrase', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });

    await expect(unwrapWithPassphrase(made.envelope, 'not the passphrase', 7)).rejects.toThrow(
      /passphrase/i,
    );
  });

  it('refuses an envelope moved to another scope', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });

    await expect(unwrapWithPassphrase(made.envelope, PASS, 8)).rejects.toThrow();
  });

  it('unwraps with the recovery key, typed in any case and with or without dashes', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });
    const typed = made.recoveryKey.toLowerCase().replace(/-/g, ' ');

    const key = await unwrapWithRecoveryKey(made.envelope, typed, 7);

    expect(key.equals(made.key)).toBe(true);
  });

  it('a new passphrase keeps the same key and the old passphrase stops working', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });

    const envelope = await rewrapWithPassphrase(
      made.envelope,
      made.key,
      'a whole new passphrase',
      7,
      FAST,
    );

    expect(
      (await unwrapWithPassphrase(envelope, 'a whole new passphrase', 7)).equals(made.key),
    ).toBe(true);
    await expect(unwrapWithPassphrase(envelope, PASS, 7)).rejects.toThrow();
    expect((await unwrapWithRecoveryKey(envelope, made.recoveryKey, 7)).equals(made.key)).toBe(
      true,
    );
  });

  it('rotating makes a new key with the next version', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });

    const rotated = await rotateScopeKey({
      scopeId: 7,
      passphrase: PASS,
      previous: made.envelope,
      cost: FAST,
    });

    expect(rotated.envelope.version).toBe(2);
    expect(rotated.key.equals(made.key)).toBe(false);
    expect(rotated.recoveryKey).not.toBe(made.recoveryKey);
  });

  it('refuses scrypt settings out of range before running them', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });
    const tampered = {
      ...made.envelope,
      passphrase: {
        ...made.envelope.passphrase,
        kdf: { ...made.envelope.passphrase.kdf, N: 2 ** 30 },
      },
    };

    await expect(unwrapWithPassphrase(tampered, PASS, 7)).rejects.toThrow();
  });

  it('recognises an envelope and rejects anything else', async () => {
    const made = await createScopeKey({ scopeId: 7, passphrase: PASS, cost: FAST });

    expect(isKeyEnvelope(made.envelope)).toBe(true);
    expect(isKeyEnvelope({ version: 1 })).toBe(false);
    expect(isKeyEnvelope(null)).toBe(false);
  });
});

describe('recovery keys', () => {
  it('formats 32 bytes as eight dash-separated groups and parses them back', () => {
    const bytes = Buffer.alloc(32, 0xab);

    const text = formatRecoveryKey(bytes);

    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{7}-){7}[0-9A-HJKMNP-TV-Z]{7}$/);
    expect(parseRecoveryKey(text)?.equals(bytes)).toBe(true);
  });

  it('reads I, L and O as the digits they look like', () => {
    const text = formatRecoveryKey(Buffer.alloc(32, 0));

    expect(parseRecoveryKey(text.replace(/0/g, 'O'))?.equals(Buffer.alloc(32, 0))).toBe(true);
  });

  it('gives null for text that is not a recovery key', () => {
    expect(parseRecoveryKey('hello')).toBeNull();
  });
});

describe('records', () => {
  const key = Buffer.alloc(32, 7);
  const where = { scopeId: 7, collection: 'ssh-servers', itemId: 'abc', keyVersion: 1 };

  it('opens what it sealed', () => {
    const sealed = sealRecord(key, where, { host: 'example.com', password: 'hunter2' });

    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('hunter2');
    expect(openRecord(key, where, sealed)).toEqual({ host: 'example.com', password: 'hunter2' });
  });

  it('refuses a record moved to another item, collection, scope or key version', () => {
    const sealed = sealRecord(key, where, { a: 1 });

    expect(() => openRecord(key, { ...where, itemId: 'other' }, sealed)).toThrow();
    expect(() => openRecord(key, { ...where, collection: 'projects' }, sealed)).toThrow();
    expect(() => openRecord(key, { ...where, scopeId: 8 }, sealed)).toThrow();
    expect(() => openRecord(key, { ...where, keyVersion: 2 }, sealed)).toThrow();
  });

  it('refuses a changed record and a wrong key', () => {
    const sealed = sealRecord(key, where, { a: 1 });
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3] as string, 'base64');
    flipped[0] = (flipped[0] as number) ^ 1;

    expect(() =>
      openRecord(key, where, [...parts.slice(0, 3), flipped.toString('base64')].join('.')),
    ).toThrow();
    expect(() => openRecord(Buffer.alloc(32, 8), where, sealed)).toThrow();
  });

  it('uses a new IV every time', () => {
    expect(sealRecord(key, where, { a: 1 })).not.toBe(sealRecord(key, where, { a: 1 }));
  });
});
