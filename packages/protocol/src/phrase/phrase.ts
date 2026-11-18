import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { base64UrlDecode, base64UrlEncode } from '../base64.js';

/**
 * Recovery phrases (E107, E108): 24 words that stand for 32 random bytes, the way a crypto wallet
 * writes its key. Runova uses a phrase in place of a typed passphrase, so it goes through the same
 * key derivation as one; this module only turns bytes into words and back, and decides when typed
 * text is a phrase.
 *
 * Making a phrase is left to the caller on purpose: only the desktop main process does it, from
 * the operating system's random source, so nothing in a renderer or on a phone can make a weak one.
 *
 * `test-vectors/recovery-phrase-v1.json` pins the format. The phone core and server core replay it.
 */

export const PHRASE_WORDS: readonly string[] = wordlist;
export const PHRASE_WORD_COUNT = 24;
export const PHRASE_ENTROPY_BYTES = 32;

/** What a phrase opens. It travels in the QR code so the phone can label what it keeps. */
export const PHRASE_PURPOSES = [
  'sync',
  'sync-recovery',
  'vault',
  'server-backup',
  'app-backup',
  'servers-passkey',
] as const;
export type PhrasePurpose = (typeof PHRASE_PURPOSES)[number];

const QR_PREFIX = 'RUNOVA-PHRASE';
const QR_VERSION = '1';

function wordsOf(text: string): string[] {
  return text.normalize('NFKD').toLowerCase().split(/\s+/u).filter(Boolean);
}

/** The words joined by single spaces, or null when the text is not a 24-word phrase. */
function canonicalPhrase(text: string): string | null {
  const words = wordsOf(text);
  if (words.length !== PHRASE_WORD_COUNT) return null;
  const joined = words.join(' ');
  return validateMnemonic(joined, wordlist) ? joined : null;
}

export function isValidPhrase(text: string): boolean {
  return canonicalPhrase(text) !== null;
}

/**
 * The exact text a key is derived from. A phrase becomes lowercase words with single spaces, so it
 * opens the same data however it was typed, pasted or scanned. Anything else is a passphrase and
 * stays exactly as typed, so passphrases set before phrases existed keep working.
 */
export function canonicalSecret(text: string): string {
  return canonicalPhrase(text) ?? text;
}

export function entropyToPhrase(entropy: Uint8Array): string {
  if (entropy.length !== PHRASE_ENTROPY_BYTES) {
    throw new Error(`A recovery phrase is made from ${PHRASE_ENTROPY_BYTES} bytes.`);
  }
  return entropyToMnemonic(entropy, wordlist);
}

/** The 32 bytes a phrase stands for, or null when the text is not a phrase. */
export function phraseToEntropy(text: string): Uint8Array | null {
  const phrase = canonicalPhrase(text);
  return phrase ? mnemonicToEntropy(phrase, wordlist) : null;
}

/** Words that start with what was typed, for autocomplete. Four letters always pick one word. */
export function suggestWords(prefix: string, limit = 6): string[] {
  const start = prefix.trim().toLowerCase();
  if (!start) return [];
  const found: string[] = [];
  for (const word of wordlist) {
    if (word.startsWith(start)) {
      found.push(word);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/**
 * The words in pasted or saved text: a numbered list ("1. zoo"), commas, dashes or line breaks.
 * Used to fill the word boxes; whether they make a phrase is checked afterwards.
 */
export function splitPhraseText(text: string): string[] {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter(Boolean);
}

export interface PhraseQr {
  purpose: PhrasePurpose | null;
  label: string | null;
  phrase: string;
}

/** The label from a QR code, or null when it is not clean base64url of UTF-8 text. */
function readLabel(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const label = base64UrlDecode(text);
  return base64UrlEncode(label) === text ? label : null;
}

/** What the QR code on screen holds. The label and purpose are not secret; the words are. */
export function phraseQrPayload(input: {
  purpose: PhrasePurpose;
  label: string;
  phrase: string;
}): string {
  const phrase = canonicalPhrase(input.phrase);
  if (!phrase) throw new Error('That is not a recovery phrase.');
  return [QR_PREFIX, QR_VERSION, input.purpose, base64UrlEncode(input.label), phrase].join(':');
}

/**
 * Reads a scanned QR code: Runova's own payload, or just the 24 words from another tool. Null for
 * anything else, including a phrase with a wrong checksum.
 */
export function parsePhraseQr(payload: string): PhraseQr | null {
  const text = payload.trim();
  if (!text.startsWith(`${QR_PREFIX}:`)) {
    const phrase = canonicalPhrase(text);
    return phrase ? { purpose: null, label: null, phrase } : null;
  }
  const parts = text.split(':');
  if (parts.length !== 5) return null;
  const [, version, purpose, label, words] = parts as [string, string, string, string, string];
  if (version !== QR_VERSION) return null;
  if (!(PHRASE_PURPOSES as readonly string[]).includes(purpose)) return null;
  const decoded = readLabel(label);
  const phrase = canonicalPhrase(words);
  if (decoded === null || !phrase) return null;
  return { purpose: purpose as PhrasePurpose, label: decoded, phrase };
}
