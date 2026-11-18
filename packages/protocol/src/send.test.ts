import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFileChunk, encodeFileChunk, transferKeyFromId } from './index.js';
import {
  encodeSendMessage,
  isSendMessage,
  parseSendMessage,
  RECEIVE_FILES_FEATURE,
  SEND_LIMITS,
  SEND_PART_BYTES,
  type SendMessage,
  safeRelativePath,
  sendPathKey,
} from './send.js';

const vectors = JSON.parse(
  readFileSync(new URL('../test-vectors/send-v1.json', import.meta.url), 'utf8'),
) as {
  feature: string;
  partBytes: number;
  limits: typeof SEND_LIMITS;
  messages: { text: string; value: SendMessage }[];
  rejected: string[];
  paths: { in: string; out: string | null }[];
  transferKeys: { id: string; key: number }[];
  chunks: { transferKey: number; partIndex: number; seq: number; bytes: string; frame: string }[];
};

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const id = (n: number) => `t-${n}`;

describe('send messages', () => {
  it('names the feature, the part size and the limits the vectors name', () => {
    expect(RECEIVE_FILES_FEATURE).toBe(vectors.feature);
    expect(SEND_PART_BYTES).toBe(vectors.partBytes);
    expect(SEND_LIMITS).toEqual(vectors.limits);
  });

  it.each(vectors.messages)('reads $text', ({ text, value }) => {
    expect(parseSendMessage(text)).toEqual(value);
  });

  it.each(vectors.messages)('writes $text byte for byte', ({ text, value }) => {
    expect(encodeSendMessage(value)).toBe(text);
  });

  it.each(vectors.rejected)('turns down %s', (text) => {
    expect(parseSendMessage(text)).toBeNull();
  });

  it('keeps only the fields it knows', () => {
    const text = JSON.stringify({ t: 'send-complete', batchId: 'b', extra: { big: true } });

    expect(parseSendMessage(text)).toEqual({ t: 'send-complete', batchId: 'b' });
  });

  it('takes as many files as the limit and no more', () => {
    const files = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ transferId: id(i), path: `f${i}`, size: 1 }));
    const offer = (n: number) =>
      JSON.stringify({ t: 'send-offer', v: 1, batchId: 'b', files: files(n) });

    expect(parseSendMessage(offer(SEND_LIMITS.maxFiles))).not.toBeNull();
    expect(parseSendMessage(offer(SEND_LIMITS.maxFiles + 1))).toBeNull();
  });

  it('turns down an offer bigger than 4 MiB even when every field is fine', () => {
    const long = `${'d'.repeat(200)}/`.repeat(4);
    const files = Array.from({ length: 6_000 }, (_, i) => ({
      transferId: id(i),
      path: `${long}${i}`,
      size: 1,
    }));
    const text = JSON.stringify({ t: 'send-offer', v: 1, batchId: 'b', files });

    expect(text.length).toBeGreaterThan(SEND_LIMITS.maxOfferBytes);
    expect(parseSendMessage(text)).toBeNull();
  });

  it('counts a note in characters, so emoji are not charged twice', () => {
    const note = '👋'.repeat(SEND_LIMITS.maxNoteChars);
    const text = JSON.stringify({
      t: 'send-offer',
      v: 1,
      batchId: 'b',
      files: [{ transferId: 'x', path: 'a', size: 1 }],
      note,
    });

    expect(parseSendMessage(text)).not.toBeNull();
  });

  it('accepts the largest whole file size a number can hold exactly', () => {
    const text = (size: number) =>
      JSON.stringify({
        t: 'send-offer',
        v: 1,
        batchId: 'b',
        files: [{ transferId: 'x', path: 'a', size }],
      });

    expect(parseSendMessage(text(Number.MAX_SAFE_INTEGER))).not.toBeNull();
    expect(parseSendMessage(text(Number.MAX_SAFE_INTEGER + 2))).toBeNull();
  });

  it('tells its own messages apart from the file transfer messages', () => {
    expect(isSendMessage({ t: 'send-ping' })).toBe(true);
    expect(isSendMessage({ t: 'file-offer' })).toBe(false);
    expect(isSendMessage(null)).toBe(false);
  });
});

describe('paths in an offer', () => {
  it.each(vectors.paths)('maps $in', ({ in: path, out }) => {
    expect(safeRelativePath(path)).toBe(out);
  });

  it('turns down anything that is not text', () => {
    expect(safeRelativePath(5 as unknown as string)).toBeNull();
  });

  it('compares paths without minding case, the way Windows and macOS do', () => {
    expect(sendPathKey('Photos/A.JPG')).toBe(sendPathKey('photos/a.jpg'));
    expect(sendPathKey('a/b')).not.toBe(sendPathKey('a/c'));
  });
});

describe('file chunks and transfer keys', () => {
  it.each(vectors.transferKeys)('keys $id as FNV-1a over UTF-16 units', ({ id, key }) => {
    expect(transferKeyFromId(id)).toBe(key);
  });

  it.each(vectors.chunks)('frames a chunk of part $partIndex', (chunk) => {
    const encoded = encodeFileChunk({
      transferKey: chunk.transferKey,
      partIndex: chunk.partIndex,
      seq: chunk.seq,
      bytes: fromHex(chunk.bytes),
    });

    expect(toHex(encoded)).toBe(chunk.frame);
    const decoded = decodeFileChunk(fromHex(chunk.frame));
    expect(decoded.transferKey).toBe(chunk.transferKey);
    expect(decoded.partIndex).toBe(chunk.partIndex);
    expect(decoded.seq).toBe(chunk.seq);
    expect(toHex(decoded.bytes)).toBe(chunk.bytes);
  });
});
