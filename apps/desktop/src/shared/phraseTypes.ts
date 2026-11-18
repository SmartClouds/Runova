import type { PhrasePurpose } from '@runova/protocol';

export type { PhrasePurpose };

/**
 * A recovery phrase on screen (E107): its 24 words to show and the id the main process keeps it
 * under. Copying, saving, the QR code and setting a key all go by the id.
 */
export interface PendingPhrase {
  id: string;
  words: string[];
}

/** In place of a typed secret: the recovery phrase made for it, by id. */
export interface PhraseRef {
  phraseId: string;
}

/** A new secret as the page sends it: what was typed, or a phrase made for it. */
export type NewSecret = string | PhraseRef;
