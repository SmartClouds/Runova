import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalSecret,
  entropyToPhrase,
  isValidPhrase,
  PHRASE_PURPOSES,
  PHRASE_WORD_COUNT,
  PHRASE_WORDS,
  type PhrasePurpose,
  parsePhraseQr,
  phraseQrPayload,
  phraseToEntropy,
  splitPhraseText,
  suggestWords,
} from './phrase.js';

/**
 * Recovery phrases (E107, E108). The phone core (Rust) and server core (.NET) replay the same
 * vectors file, so these tests pin the format all three read.
 */

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, '..', '..', 'test-vectors', 'recovery-phrase-v1.json'), 'utf8'),
) as {
  entropy: { entropy: string; phrase: string }[];
  canonical: { about: string; input: string; output: string; isPhrase: boolean }[];
  qr: { purpose: PhrasePurpose; label: string; phrase: string; payload: string }[];
  badQr: { about: string; payload: string }[];
  bareQr: { about: string; payload: string; phrase: string }[];
  purposes: string[];
};

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('recovery phrase words', () => {
  it('uses the 2048 BIP39 English words, unique in their first four letters', () => {
    expect(PHRASE_WORDS).toHaveLength(2048);
    expect(new Set(PHRASE_WORDS.map((w) => w.slice(0, 4))).size).toBe(2048);
    expect(PHRASE_WORD_COUNT).toBe(24);
  });

  it.each(vectors.entropy)('turns $entropy into its words and back', ({ entropy, phrase }) => {
    expect(entropyToPhrase(hex(entropy))).toBe(phrase);
    expect(toHex(phraseToEntropy(phrase) ?? new Uint8Array())).toBe(entropy);
    expect(isValidPhrase(phrase)).toBe(true);
  });

  it('only makes phrases from 32 bytes', () => {
    expect(() => entropyToPhrase(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe('canonicalSecret', () => {
  it.each(vectors.canonical)('$about', ({ input, output, isPhrase }) => {
    expect(canonicalSecret(input)).toBe(output);
    expect(isValidPhrase(input)).toBe(isPhrase);
    if (!isPhrase) expect(phraseToEntropy(input)).toBeNull();
  });
});

describe('suggestWords', () => {
  it('finds words by their start, ignoring case', () => {
    expect(suggestWords('aba')).toEqual(['abandon']);
    expect(suggestWords('ZO')).toEqual(['zone', 'zoo']);
    expect(suggestWords('wa', 2)).toEqual(['wage', 'wagon']);
    expect(suggestWords(' Zoo ')).toEqual(['zoo']);
  });

  it('suggests nothing for an empty or unknown start', () => {
    expect(suggestWords('')).toEqual([]);
    expect(suggestWords('qx')).toEqual([]);
  });
});

describe('splitPhraseText', () => {
  it('reads words out of a saved file, a numbered list or a pasted line', () => {
    expect(splitPhraseText(' 1. Zoo\n2) zoo, 3 - vote ')).toEqual(['zoo', 'zoo', 'vote']);
    expect(splitPhraseText('legal-winner\tthank')).toEqual(['legal', 'winner', 'thank']);
    expect(splitPhraseText('')).toEqual([]);
  });
});

describe('phrase QR codes', () => {
  it('names every purpose the apps know', () => {
    expect([...PHRASE_PURPOSES]).toEqual(vectors.purposes);
  });

  it.each(vectors.qr)(
    'writes and reads the $purpose payload',
    ({ purpose, label, phrase, payload }) => {
      expect(phraseQrPayload({ purpose, label, phrase })).toBe(payload);
      expect(parsePhraseQr(payload)).toEqual({ purpose, label, phrase });
    },
  );

  it.each(vectors.badQr)('rejects $about', ({ payload }) => {
    expect(parsePhraseQr(payload)).toBeNull();
  });

  it.each(vectors.bareQr)('accepts $about', ({ payload, phrase }) => {
    expect(parsePhraseQr(payload)).toEqual({ purpose: null, label: null, phrase });
  });

  it('refuses to write a QR code for words that are not a phrase', () => {
    expect(() =>
      phraseQrPayload({ purpose: 'sync', label: 'x', phrase: 'not a phrase at all' }),
    ).toThrow(/not a recovery phrase/);
  });
});
