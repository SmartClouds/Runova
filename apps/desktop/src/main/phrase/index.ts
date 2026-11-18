import { canonicalSecret } from '@runova/protocol';
import { createPhraseRegistry } from './registry';

/** The one registry of recovery phrases on screen (E107), shared by every channel that sets a key. */
export const phraseRegistry = createPhraseRegistry();

/**
 * The secret a key is set or opened with: a typed passphrase as is, or the phrase behind an id.
 * `owner` is the window that asked for the phrase.
 */
export function secretFrom(
  input: { passphrase?: string; phraseId?: string },
  owner: number,
): string {
  if (input.phraseId) return phraseRegistry.secret(input.phraseId, owner);
  if (input.passphrase) return input.passphrase;
  throw new Error('Type a passphrase or make a recovery phrase first.');
}

const PHRASE_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * A secret field from a page: typed text, with a typed phrase written in its one canonical form,
 * or `{ phraseId }` for a phrase made here. Null for anything else.
 */
export function readSecret(value: unknown, owner: number): string | null {
  if (typeof value === 'string') return canonicalSecret(value);
  const phraseId = (value as { phraseId?: unknown } | null)?.phraseId;
  return typeof phraseId === 'string' && PHRASE_ID.test(phraseId)
    ? phraseRegistry.secret(phraseId, owner)
    : null;
}
