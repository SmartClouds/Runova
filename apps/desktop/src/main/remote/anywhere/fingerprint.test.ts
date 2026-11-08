import { describe, expect, it } from 'vitest';
import { keyFingerprint } from './fingerprint';

const SEVENS = Buffer.alloc(32, 7).toString('base64url');

describe('keyFingerprint', () => {
  it('is the start of the key hash, the same as the phone works out', () => {
    expect(keyFingerprint(SEVENS)).toBe('4BB0 6F8E');
  });

  it('differs for a different key', () => {
    expect(keyFingerprint(Buffer.alloc(32, 8).toString('base64url'))).not.toBe('4BB0 6F8E');
  });
});
