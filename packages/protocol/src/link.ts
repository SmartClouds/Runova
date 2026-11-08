/**
 * Runova Anywhere link framing (E61). Two computers that reach each other through a WebRTC data
 * channel or the website's relay send the same frames over either, so everything above (the
 * handshake, then the usual control and binary messages) does not care which one it is.
 *
 * A frame starts with its kind:
 *
 * - `0x01` text: the rest is one JSON control message in UTF-8.
 * - `0x02` binary: the rest is one binary message (a screen tile, a file chunk...).
 * - `0x03` fragment: `[0x03][message id u32][index u16][count u16][inner kind u8][chunk]`, all
 *   big-endian. A message too large for one frame is sent as `count` fragments in order, with
 *   nothing between them, which an ordered transport guarantees.
 *
 * No frame is longer than {@link LINK_MAX_FRAME}, which every data channel accepts.
 */

export const LINK_TEXT = 0x01;
export const LINK_BINARY = 0x02;
export const LINK_FRAGMENT = 0x03;

export type LinkKind = typeof LINK_TEXT | typeof LINK_BINARY;

/** 60 KiB: under the 64 KiB a data channel message is guaranteed to carry. */
export const LINK_MAX_FRAME = 60 * 1024;
const FRAGMENT_HEADER = 10;
const FRAGMENT_CHUNK = LINK_MAX_FRAME - FRAGMENT_HEADER;
/** A file part is 10 MiB and travels in 64 KiB chunks, so 32 MiB leaves plenty of room. */
export const LINK_MAX_MESSAGE = 32 * 1024 * 1024;

export class LinkFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkFramingError';
  }
}

export interface LinkMessage {
  kind: LinkKind;
  payload: Uint8Array;
}

/** The frames for one message. `messageId` only has to differ from the previous fragmented one. */
export function encodeLinkMessage(
  kind: number,
  payload: Uint8Array,
  messageId: number,
): Uint8Array[] {
  if (kind !== LINK_TEXT && kind !== LINK_BINARY)
    throw new Error('Only text and binary messages are framed.');
  if (payload.length + 1 <= LINK_MAX_FRAME) {
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    return [frame];
  }

  const count = Math.ceil(payload.length / FRAGMENT_CHUNK);
  if (count > 0xffff) throw new Error('That message is too large for the link.');
  const frames: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const chunk = payload.subarray(index * FRAGMENT_CHUNK, (index + 1) * FRAGMENT_CHUNK);
    const frame = new Uint8Array(FRAGMENT_HEADER + chunk.length);
    const view = new DataView(frame.buffer);
    frame[0] = LINK_FRAGMENT;
    view.setUint32(1, messageId >>> 0, false);
    view.setUint16(5, index, false);
    view.setUint16(7, count, false);
    frame[9] = kind;
    frame.set(chunk, FRAGMENT_HEADER);
    frames.push(frame);
  }
  return frames;
}

/** Turns frames back into messages. Throws on anything malformed; the link then closes. */
export class LinkReassembler {
  private readonly maxMessageBytes: number;
  private partial: {
    id: number;
    count: number;
    next: number;
    kind: LinkKind;
    chunks: Uint8Array[];
    bytes: number;
  } | null = null;

  constructor(options: { maxMessageBytes?: number } = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? LINK_MAX_MESSAGE;
  }

  push(frame: Uint8Array): LinkMessage | null {
    if (frame.length === 0) throw new LinkFramingError('An empty frame.');
    const kind = frame[0];
    if (kind === LINK_TEXT || kind === LINK_BINARY) {
      if (this.partial)
        throw new LinkFramingError('A whole message arrived in the middle of a fragmented one.');
      return { kind, payload: frame.subarray(1) };
    }
    if (kind !== LINK_FRAGMENT) throw new LinkFramingError(`An unknown frame kind ${kind}.`);
    if (frame.length < FRAGMENT_HEADER)
      throw new LinkFramingError('A fragment too short for its header.');

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const id = view.getUint32(1, false);
    const index = view.getUint16(5, false);
    const count = view.getUint16(7, false);
    const inner = frame[9];
    if (count < 2 || index >= count || (inner !== LINK_TEXT && inner !== LINK_BINARY)) {
      throw new LinkFramingError('A fragment with a bad header.');
    }
    if (count * FRAGMENT_CHUNK > this.maxMessageBytes + FRAGMENT_CHUNK) {
      throw new LinkFramingError('A message larger than the link allows.');
    }

    if (index === 0) {
      if (this.partial)
        throw new LinkFramingError('A new message started before the last one ended.');
      this.partial = { id, count, next: 0, kind: inner, chunks: [], bytes: 0 };
    }
    const partial = this.partial;
    if (
      !partial ||
      partial.id !== id ||
      partial.count !== count ||
      partial.next !== index ||
      partial.kind !== inner
    ) {
      throw new LinkFramingError('A fragment out of order.');
    }

    const chunk = frame.subarray(FRAGMENT_HEADER);
    partial.bytes += chunk.length;
    if (partial.bytes > this.maxMessageBytes)
      throw new LinkFramingError('A message larger than the link allows.');
    partial.chunks.push(chunk.slice());
    partial.next++;
    if (partial.next < count) return null;

    this.partial = null;
    const payload = new Uint8Array(partial.bytes);
    let offset = 0;
    for (const part of partial.chunks) {
      payload.set(part, offset);
      offset += part.length;
    }
    return { kind: partial.kind, payload };
  }
}
