import { isValidPhrase } from '@runova/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhraseRegistry } from './registry';

/** Phrases waiting on screen to be used (E107). Only their id ever comes back from a page. */

const ZEROS = Buffer.alloc(32);
const ZERO_PHRASE = `${'abandon '.repeat(23)}art`;

describe('phrase registry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('makes a fresh 24-word phrase from the random source for every request', () => {
    const registry = createPhraseRegistry();
    const first = registry.create({ purpose: 'sync', label: 'Personal', owner: 1 });
    const second = registry.create({ purpose: 'sync', label: 'Personal', owner: 1 });

    expect(first.words).toHaveLength(24);
    expect(isValidPhrase(first.words.join(' '))).toBe(true);
    expect(first.words.join(' ')).not.toBe(second.words.join(' '));
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('builds the phrase from 32 bytes of the random source', () => {
    const random = vi.fn((n: number) => (n === 32 ? Buffer.from(ZEROS) : Buffer.alloc(n, 7)));
    const registry = createPhraseRegistry({ random });

    const made = registry.create({ purpose: 'vault', label: 'Vault', owner: 1 });

    expect(made.words.join(' ')).toBe(ZERO_PHRASE);
    expect(random).toHaveBeenCalledWith(32);
  });

  it('hands the phrase over as often as a key is tried, so a failed attempt can be retried', () => {
    const registry = createPhraseRegistry({ random: (n) => Buffer.alloc(n) });
    const made = registry.create({ purpose: 'sync', label: 'Personal', owner: 1 });

    expect(registry.secret(made.id)).toBe(ZERO_PHRASE);
    expect(registry.secret(made.id)).toBe(ZERO_PHRASE);
  });

  it('wipes the bytes of a phrase the page is done with', () => {
    const registry = createPhraseRegistry({ random: (n) => Buffer.alloc(n) });
    const made = registry.create({ purpose: 'sync', label: 'Personal', owner: 1 });
    const held = registry.bytesForTest(made.id);

    registry.discard(made.id);

    expect(held?.every((b) => b === 0)).toBe(true);
    expect(() => registry.secret(made.id)).toThrow(/no longer there/);
    expect(registry.size()).toBe(0);
  });

  it('lets the page look again without using it up, for copy, save and the QR code', () => {
    const registry = createPhraseRegistry();
    const made = registry.create({ purpose: 'server-backup', label: 'web-1', owner: 1 });

    expect(registry.peek(made.id)).toEqual({
      purpose: 'server-backup',
      label: 'web-1',
      phrase: made.words.join(' '),
    });
    expect(registry.size()).toBe(1);
  });

  it('keeps a phrase it was given, such as a new recovery key, under its own id', () => {
    const registry = createPhraseRegistry();
    const id = registry.hold({
      purpose: 'sync-recovery',
      label: 'Personal',
      phrase: ZERO_PHRASE,
      owner: 2,
    });

    expect(registry.peek(id)?.phrase).toBe(ZERO_PHRASE);
    expect(() =>
      registry.hold({ purpose: 'sync', label: 'x', phrase: 'not a phrase', owner: 2 }),
    ).toThrow(/not a recovery phrase/);
  });

  it('forgets a phrase after fifteen minutes, even if nothing asks for it again', () => {
    const registry = createPhraseRegistry({ random: (n) => Buffer.alloc(n) });
    const made = registry.create({ purpose: 'sync', label: 'Personal', owner: 1 });
    const held = registry.bytesForTest(made.id);

    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(registry.peek(made.id)).not.toBeNull();
    vi.advanceTimersByTime(1);

    expect(registry.peek(made.id)).toBeNull();
    expect(held?.every((b) => b === 0)).toBe(true);
  });

  it('drops what a window held when it closes, and leaves other windows alone', () => {
    const registry = createPhraseRegistry();
    const mine = registry.create({ purpose: 'sync', label: 'a', owner: 1 });
    const theirs = registry.create({ purpose: 'sync', label: 'b', owner: 2 });

    registry.discardOwnedBy(1);

    expect(registry.peek(mine.id)).toBeNull();
    expect(registry.peek(theirs.id)).not.toBeNull();
  });

  it('only lets the window that asked for a phrase use it', () => {
    const registry = createPhraseRegistry();
    const made = registry.create({ purpose: 'sync', label: 'a', owner: 1 });

    expect(registry.peek(made.id, 2)).toBeNull();
    expect(() => registry.secret(made.id, 2)).toThrow(/no longer there/);
    expect(registry.secret(made.id, 1)).toBe(made.words.join(' '));
  });

  it('discards on request and ignores an unknown id', () => {
    const registry = createPhraseRegistry();
    const made = registry.create({ purpose: 'sync', label: 'a', owner: 1 });

    registry.discard(made.id);
    registry.discard('nothing-here');

    expect(registry.size()).toBe(0);
  });
});
