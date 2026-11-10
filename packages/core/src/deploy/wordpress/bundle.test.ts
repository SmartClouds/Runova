import { describe, expect, it } from 'vitest';
import {
  decodeWpFrame,
  decodeWpResponse,
  encodeWpFrame,
  encodeWpMultipart,
  encodeWpResponse,
} from './bundle.js';

const enc = new TextEncoder();

describe('frames', () => {
  it('round-trip blobs of every size, as views into the input', () => {
    const blobs = [new Uint8Array(0), enc.encode('a'), new Uint8Array(70_000).fill(3)];
    const bytes = encodeWpFrame({ route: '/deploy/upload', body: { deployId: 'd' }, blobs });
    const frame = decodeWpFrame(bytes);
    expect(frame?.body).toEqual({ deployId: 'd' });
    expect(frame?.blobs.map((blob) => blob.length)).toEqual([0, 1, 70_000]);
    expect(frame?.blobs[2].buffer).toBe(bytes.buffer);
  });

  it('enforce the header and blob limits on both sides', () => {
    expect(() =>
      encodeWpFrame({
        route: '/hello',
        body: {},
        blobs: Array.from({ length: 1001 }, () => new Uint8Array(0)),
      }),
    ).toThrow(/blobs/);
    expect(() =>
      encodeWpFrame({ route: '/hello', body: 'x'.repeat(1024 * 1024), blobs: [] }),
    ).toThrow(/header/);
    const bytes = encodeWpFrame({
      route: '/hello',
      body: {},
      blobs: [new Uint8Array(1), new Uint8Array(1)],
    });
    expect(decodeWpFrame(bytes, { maxBlobs: 1 })).toBeNull();
    expect(decodeWpFrame(bytes, { maxHeaderBytes: 4 })).toBeNull();
    expect(decodeWpFrame(new Uint8Array(0))).toBeNull();
  });

  it('refuse a header that is not UTF-8', () => {
    const bytes = encodeWpFrame({ route: '/hello', body: {}, blobs: [] });
    bytes[10] = 0xff;
    expect(decodeWpFrame(bytes)).toBeNull();
  });
});

describe('response envelopes', () => {
  const sig = 'B'.repeat(86);

  it('round-trip, an unsigned 429 included', () => {
    const payload = enc.encode('gz');
    for (const meta of [
      { ts: 9, status: 200, sig },
      { ts: 9, status: 429, sig: '' },
    ]) {
      const decoded = decodeWpResponse(encodeWpResponse(meta, payload));
      expect(decoded?.meta).toEqual(meta);
      expect(decoded?.payload).toEqual(payload);
    }
  });

  it('tell an error page apart from the plugin', () => {
    expect(
      decodeWpResponse(enc.encode('<!DOCTYPE html><title>Just a moment...</title>')),
    ).toBeNull();
    const envelope = (meta: string) => {
      const json = enc.encode(meta);
      const out = new Uint8Array(10 + json.length);
      out.set(enc.encode('RNWR1\n'));
      new DataView(out.buffer).setUint32(6, json.length);
      out.set(json, 10);
      return out;
    };
    expect(decodeWpResponse(envelope('{"ts":1,"status":200,"sig":"short"}'))).toBeNull();
    expect(decodeWpResponse(envelope('{"ts":-1,"status":200,"sig":""}'))).toBeNull();
    expect(decodeWpResponse(envelope('{"ts":1,"status":600,"sig":""}'))).toBeNull();
    expect(decodeWpResponse(envelope('null'))).toBeNull();
    expect(decodeWpResponse(envelope('{'))).toBeNull();
    expect(
      decodeWpResponse(envelope(`{"ts":1,"status":200,"sig":"","pad":"${'x'.repeat(4100)}"}`)),
    ).toBeNull();
  });
});

describe('multipart', () => {
  it('refuse unsafe boundaries and auth values', () => {
    expect(() => encodeWpMultipart('v1', new Uint8Array(0), 'short')).toThrow(/boundary/);
    expect(() => encodeWpMultipart('a"b', new Uint8Array(0), 'B'.repeat(20))).toThrow(/quotes/);
  });
});
