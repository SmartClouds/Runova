import { describe, expect, it } from 'vitest';
import { phraseRegistry, readSecret, secretFrom } from '.';

/** Turning what a page sent into the secret a key is set or opened with (E107). */

const PHRASE = `${'zoo '.repeat(23)}vote`;

describe('secretFrom', () => {
  it('reads the phrase behind an id, only for the window that made it', () => {
    const made = phraseRegistry.create({ purpose: 'sync', label: 'x', owner: 5 });

    expect(() => secretFrom({ phraseId: made.id }, 6)).toThrow(/no longer there/);
    expect(secretFrom({ phraseId: made.id }, 5)).toBe(made.words.join(' '));
    phraseRegistry.discard(made.id);
    expect(() => secretFrom({ phraseId: made.id }, 5)).toThrow(/no longer there/);
  });

  it('passes a typed passphrase through and refuses nothing at all', () => {
    expect(secretFrom({ passphrase: 'typed by hand' }, 5)).toBe('typed by hand');
    expect(() => secretFrom({}, 5)).toThrow(/Type a passphrase/);
  });
});

describe('readSecret', () => {
  it('reads typed text, writing a typed phrase in its one canonical form', () => {
    expect(readSecret('Open Sesame ', 1)).toBe('Open Sesame ');
    expect(readSecret(PHRASE.toUpperCase().replace(/ /g, '\n'), 1)).toBe(PHRASE);
  });

  it('reads { phraseId } as the phrase it stands for', () => {
    const made = phraseRegistry.create({ purpose: 'server-backup', label: 'x', owner: 1 });
    expect(readSecret({ phraseId: made.id }, 1)).toBe(made.words.join(' '));
  });

  it('gives null for anything else, so the caller can say what it expected', () => {
    expect(readSecret(42, 1)).toBeNull();
    expect(readSecret({ phraseId: '../etc' }, 1)).toBeNull();
    expect(readSecret(null, 1)).toBeNull();
  });
});
