import { describe, expect, it } from 'vitest';
import type { RandomFill } from '../../vault/generator.js';
import { checkCatalogSecret, generateCatalogSecret, generateCatalogSecrets } from './secrets.js';
import type { CatalogSecretSpec } from './types.js';

const PASSWORD: CatalogSecretSpec = {
  key: 'DB_PASSWORD',
  label: 'Database password',
  kind: 'password',
  length: 32,
};
const KEY: CatalogSecretSpec = { key: 'APP_KEY', label: 'App key', kind: 'hex', length: 32 };

/** A repeatable stand-in for the platform's random source. */
function seeded(seed: number): RandomFill {
  let state = seed;
  return (array) => {
    for (let i = 0; i < array.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      array[i] = state;
    }
    return array;
  };
}

describe('generateCatalogSecret', () => {
  it('makes passwords from letters and digits with every class present', () => {
    for (let i = 0; i < 200; i++) {
      const value = generateCatalogSecret(PASSWORD);
      expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[0-9]/);
      expect(checkCatalogSecret(PASSWORD, value)).toBeNull();
    }
  });

  it('makes hex keys of the given number of bytes', () => {
    const value = generateCatalogSecret(KEY);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(checkCatalogSecret(KEY, value)).toBeNull();
  });

  // A repeat would show up in a few hundred values. 4,000 drew one random number per character
  // and took over 5 s on a busy CI Mac.
  it('never repeats a value', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateCatalogSecret(PASSWORD));
    for (let i = 0; i < 500; i++) seen.add(generateCatalogSecret(KEY));
    expect(seen.size).toBe(1000);
  });

  it('draws from the random source it is given', () => {
    expect(generateCatalogSecret(PASSWORD, seeded(1))).toBe(
      generateCatalogSecret(PASSWORD, seeded(1)),
    );
    expect(generateCatalogSecret(PASSWORD, seeded(1))).not.toBe(
      generateCatalogSecret(PASSWORD, seeded(2)),
    );
    expect(generateCatalogSecret(KEY, seeded(3))).toBe(generateCatalogSecret(KEY, seeded(3)));
  });

  it('refuses specs too weak to be worth generating', () => {
    expect(() => generateCatalogSecret({ ...PASSWORD, length: 12 })).toThrow(RangeError);
    expect(() => generateCatalogSecret({ ...KEY, length: 8 })).toThrow(RangeError);
    expect(() => generateCatalogSecret({ ...PASSWORD, length: 1000 })).toThrow(RangeError);
  });
});

describe('generateCatalogSecrets', () => {
  it('fills every spec, each with its own value', () => {
    const values = generateCatalogSecrets([PASSWORD, KEY]);
    expect(Object.keys(values)).toEqual(['DB_PASSWORD', 'APP_KEY']);
    expect(values.DB_PASSWORD).not.toBe(values.APP_KEY);
  });
});

describe('checkCatalogSecret', () => {
  it('accepts a strong password of its own', () => {
    expect(checkCatalogSecret(PASSWORD, 'Correct-Horse_Battery.Staple~42')).toBeNull();
  });

  it('explains what is wrong without repeating the value', () => {
    const cases: [CatalogSecretSpec, string, RegExp][] = [
      [PASSWORD, '', /enter/i],
      [PASSWORD, 'Short1a', /at least 16/],
      [PASSWORD, 'alllowercaseletters123', /capital/],
      [PASSWORD, 'ALLUPPERCASELETTERS123', /lowercase/],
      [PASSWORD, 'NoDigitsInThisOneAtAll', /digit/],
      [PASSWORD, 'Has a space in it 12345', /letters, digits/],
      [PASSWORD, 'Quote"Breaks$Things1234', /letters, digits/],
      [PASSWORD, `Aa1${'x'.repeat(200)}`, /at most 128/],
      [KEY, 'abc', /64 hex/],
      [KEY, 'G'.repeat(64), /64 hex/],
    ];
    for (const [spec, value, reason] of cases) {
      const problem = checkCatalogSecret(spec, value);
      expect(problem, value).toMatch(reason);
      if (value.length > 0) expect(problem).not.toContain(value);
    }
  });

  it('accepts uppercase hex', () => {
    expect(checkCatalogSecret(KEY, 'AB'.repeat(32))).toBeNull();
  });
});
