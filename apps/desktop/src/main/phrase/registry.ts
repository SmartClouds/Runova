import { randomBytes } from 'node:crypto';
import {
  canonicalSecret,
  entropyToPhrase,
  isValidPhrase,
  type PhrasePurpose,
} from '@runova/protocol';

/**
 * Recovery phrases waiting on screen to be used (E107). A phrase is made here, in the main
 * process, from the operating system's random source; the page gets its words to show and an id.
 * Setting a key sends back only the id. The page discards the phrase when it is done with it.
 *
 * Each phrase belongs to the window that asked for it, and goes when that window closes or after
 * fifteen minutes. The bytes are zeroed when it goes. The strings that were shown on screen can
 * not be, which RISKS.md notes.
 */

const LIFETIME_MS = 15 * 60_000;
const ENTROPY_BYTES = 32;

export interface PendingPhrase {
  id: string;
  words: string[];
}

export interface HeldPhrase {
  purpose: PhrasePurpose;
  label: string;
  phrase: string;
}

interface Entry {
  purpose: PhrasePurpose;
  label: string;
  owner: number;
  bytes: Buffer;
  timer: ReturnType<typeof setTimeout>;
}

export function createPhraseRegistry(deps: { random?: (n: number) => Buffer } = {}) {
  const random = deps.random ?? randomBytes;
  const entries = new Map<string, Entry>();

  const drop = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.bytes.fill(0);
    entries.delete(id);
  };

  const find = (id: string, owner?: number) => {
    const entry = entries.get(id);
    return entry && (owner === undefined || entry.owner === owner) ? entry : null;
  };

  const store = (
    input: { purpose: PhrasePurpose; label: string; owner: number },
    phrase: string,
  ) => {
    const id = random(16).toString('base64url');
    const timer = setTimeout(() => drop(id), LIFETIME_MS);
    timer.unref?.();
    entries.set(id, { ...input, bytes: Buffer.from(phrase, 'utf-8'), timer });
    return id;
  };

  return {
    /** A new phrase from 32 random bytes. */
    create(input: { purpose: PhrasePurpose; label: string; owner: number }): PendingPhrase {
      const entropy = random(ENTROPY_BYTES);
      const phrase = entropyToPhrase(new Uint8Array(entropy));
      entropy.fill(0);
      return { id: store(input, phrase), words: phrase.split(' ') };
    },

    /** Keeps a phrase made elsewhere, such as a new sync recovery key, so the page can show it. */
    hold(input: { purpose: PhrasePurpose; label: string; phrase: string; owner: number }): string {
      if (!isValidPhrase(input.phrase)) throw new Error('That is not a recovery phrase.');
      const { phrase, ...rest } = input;
      return store(rest, canonicalSecret(phrase));
    },

    peek(id: string, owner?: number): HeldPhrase | null {
      const entry = find(id, owner);
      return entry
        ? { purpose: entry.purpose, label: entry.label, phrase: entry.bytes.toString('utf-8') }
        : null;
    },

    /**
     * The phrase, to set a key with. It stays until the page discards it, so an attempt that
     * fails (a dropped connection, say) can be tried again with the phrase already written down.
     */
    secret(id: string, owner?: number): string {
      const entry = find(id, owner);
      if (!entry) {
        throw new Error('That recovery phrase is no longer there. Make a new one and try again.');
      }
      return entry.bytes.toString('utf-8');
    },

    discard(id: string, owner?: number): void {
      if (find(id, owner)) drop(id);
    },

    discardOwnedBy(owner: number): void {
      for (const [id, entry] of entries) if (entry.owner === owner) drop(id);
    },

    size: () => entries.size,

    /** The buffer behind a phrase, so tests can see it is wiped. */
    bytesForTest: (id: string) => entries.get(id)?.bytes,
  };
}

export type PhraseRegistry = ReturnType<typeof createPhraseRegistry>;
