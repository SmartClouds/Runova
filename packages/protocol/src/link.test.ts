import { describe, expect, it } from 'vitest';
import {
  encodeLinkMessage,
  LINK_BINARY,
  LINK_FRAGMENT,
  LINK_MAX_FRAME,
  LINK_TEXT,
  LinkFramingError,
  LinkReassembler,
} from './link.js';

const text = (s: string) => new TextEncoder().encode(s);

function filled(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 251;
  return out;
}

describe('link framing', () => {
  it('sends a small control message as one text frame', () => {
    const frames = encodeLinkMessage(LINK_TEXT, text('{"t":"ping"}'), 1);

    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe(LINK_TEXT);
    expect(new TextDecoder().decode(frames[0].subarray(1))).toBe('{"t":"ping"}');
  });

  it('sends a small binary message as one binary frame', () => {
    const frames = encodeLinkMessage(LINK_BINARY, new Uint8Array([1, 2, 3]), 1);

    expect([...frames[0]]).toEqual([LINK_BINARY, 1, 2, 3]);
  });

  it('splits a large message into fragments that each fit a data channel message', () => {
    const payload = filled(200_000);

    const frames = encodeLinkMessage(LINK_BINARY, payload, 42);

    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) {
      expect(frame[0]).toBe(LINK_FRAGMENT);
      expect(frame.length).toBeLessThanOrEqual(LINK_MAX_FRAME);
    }
  });

  it('puts fragments back together, around small messages before and after', () => {
    const big = filled(150_001);
    const assembler = new LinkReassembler();
    const frames = [
      ...encodeLinkMessage(LINK_TEXT, text('before'), 1),
      ...encodeLinkMessage(LINK_BINARY, big, 2),
      ...encodeLinkMessage(LINK_TEXT, text('after'), 3),
    ];

    const messages = frames.map((f) => assembler.push(f)).filter((m) => m !== null);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ kind: LINK_TEXT, payload: text('before') });
    expect(messages[1]?.kind).toBe(LINK_BINARY);
    expect(messages[1]?.payload).toEqual(big);
    expect(messages[2]).toEqual({ kind: LINK_TEXT, payload: text('after') });
  });

  it('refuses a whole frame in the middle of a fragmented one', () => {
    const assembler = new LinkReassembler();
    const fragments = encodeLinkMessage(LINK_BINARY, filled(150_000), 2);
    assembler.push(fragments[0]);

    expect(() => assembler.push(encodeLinkMessage(LINK_TEXT, text('x'), 3)[0])).toThrow(
      LinkFramingError,
    );
  });

  it('refuses fragments out of order', () => {
    const assembler = new LinkReassembler();
    const fragments = encodeLinkMessage(LINK_BINARY, filled(150_000), 2);
    assembler.push(fragments[0]);

    expect(() => assembler.push(fragments[2])).toThrow(LinkFramingError);
  });

  it('refuses a message larger than the limit before buffering it', () => {
    const assembler = new LinkReassembler({ maxMessageBytes: 100_000 });
    const fragments = encodeLinkMessage(LINK_BINARY, filled(150_000), 2);

    expect(() => {
      for (const f of fragments) assembler.push(f);
    }).toThrow(LinkFramingError);
  });

  it('refuses an unknown or empty frame', () => {
    const assembler = new LinkReassembler();

    expect(() => assembler.push(new Uint8Array())).toThrow(LinkFramingError);
    expect(() => assembler.push(new Uint8Array([0x7f, 1]))).toThrow(LinkFramingError);
    expect(() => assembler.push(new Uint8Array([LINK_FRAGMENT, 0, 0]))).toThrow(LinkFramingError);
  });

  it('refuses to fragment a message kind that is not text or binary', () => {
    expect(() => encodeLinkMessage(LINK_FRAGMENT, new Uint8Array(4), 1)).toThrow();
  });
});
