import {
  isWpRoute,
  WP_AUTH_FIELD,
  WP_BUNDLE_FIELD,
  WP_BUNDLE_FILENAME,
  WP_MAX_FRAME_BLOBS,
  WP_MAX_FRAME_HEADER_BYTES,
  type WpRoute,
} from './protocol.js';

/**
 * The binary framing of the WordPress connector protocol (E19). Compression and hashing happen
 * outside, on each side's own crypto, so this file stays pure.
 *
 * Frame (requests and responses alike), before gzip:
 *   "RNWB1\n" (6 bytes) | header length (uint32, big-endian) | header JSON (UTF-8) | blobs
 * where the header is `{"r": route, "b": body, "l": [length of each blob]}` and the blobs follow
 * back to back. Nothing may come after the last blob.
 *
 * Response envelope, as sent (not compressed):
 *   "RNWR1\n" (6 bytes) | meta length (uint32, big-endian) | meta JSON | gzip(frame)
 * where meta is `{"ts": unix seconds, "status": HTTP status, "sig": base64url Ed25519}`, signed
 * over wpCanonicalResponse with the hash of the gzip bytes that follow.
 */

export const WP_FRAME_MAGIC = 'RNWB1\n';
export const WP_RESPONSE_MAGIC = 'RNWR1\n';

export interface WpFrame<T = unknown> {
  route: WpRoute;
  body: T;
  blobs: Uint8Array[];
}

export interface WpResponseMeta {
  ts: number;
  status: number;
  /** Empty only on an unsigned 429 from the rate limiter, which the client labels unverified. */
  sig: string;
}

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 255;
  target[offset + 1] = (value >>> 16) & 255;
  target[offset + 2] = (value >>> 8) & 255;
  target[offset + 3] = value & 255;
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    ((source[offset] << 24) >>> 0) +
    (source[offset + 1] << 16) +
    (source[offset + 2] << 8) +
    source[offset + 3]
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The uncompressed frame bytes. */
export function encodeWpFrame(frame: WpFrame): Uint8Array {
  if (frame.blobs.length > WP_MAX_FRAME_BLOBS) throw new Error('Too many blobs for one frame.');
  const header = encoder.encode(
    JSON.stringify({ r: frame.route, b: frame.body, l: frame.blobs.map((blob) => blob.length) }),
  );
  if (header.length > WP_MAX_FRAME_HEADER_BYTES) throw new Error('The frame header is too large.');
  const length = new Uint8Array(4);
  writeUint32(length, 0, header.length);
  return concat([ascii(WP_FRAME_MAGIC), length, header, ...frame.blobs]);
}

/**
 * Reads uncompressed frame bytes. Null for anything malformed: wrong magic, a header over the
 * limit or not JSON, an unknown route, bad blob lengths, too many blobs, or bytes left over.
 * Blobs are views into the input, not copies.
 */
export function decodeWpFrame(
  bytes: Uint8Array,
  limits: { maxHeaderBytes?: number; maxBlobs?: number } = {},
): WpFrame | null {
  const maxHeader = limits.maxHeaderBytes ?? WP_MAX_FRAME_HEADER_BYTES;
  const maxBlobs = limits.maxBlobs ?? WP_MAX_FRAME_BLOBS;
  const start = WP_FRAME_MAGIC.length;
  if (!startsWith(bytes, WP_FRAME_MAGIC) || bytes.length < start + 4) return null;
  const headerLength = readUint32(bytes, start);
  if (headerLength > maxHeader || bytes.length < start + 4 + headerLength) return null;
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(start + 4, start + 4 + headerLength),
      ),
    );
  } catch {
    return null;
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) return null;
  const { r, b, l } = header as { r?: unknown; b?: unknown; l?: unknown };
  if (!isWpRoute(r) || !('b' in header) || !Array.isArray(l) || l.length > maxBlobs) return null;
  let at = start + 4 + headerLength;
  const blobs: Uint8Array[] = [];
  for (const length of l) {
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
    if (at + length > bytes.length) return null;
    blobs.push(bytes.subarray(at, at + length));
    at += length;
  }
  if (at !== bytes.length) return null;
  return { route: r, body: b, blobs };
}

/** The response as sent: envelope magic, meta, then the gzip frame untouched. */
export function encodeWpResponse(meta: WpResponseMeta, gzippedFrame: Uint8Array): Uint8Array {
  const json = encoder.encode(JSON.stringify({ ts: meta.ts, status: meta.status, sig: meta.sig }));
  const length = new Uint8Array(4);
  writeUint32(length, 0, json.length);
  return concat([ascii(WP_RESPONSE_MAGIC), length, json, gzippedFrame]);
}

/**
 * Splits a reply into its meta and the gzip payload. Null when it is not an envelope at all,
 * which is how a challenge page from Cloudflare or an error page from the host is told apart.
 */
export function decodeWpResponse(
  bytes: Uint8Array,
): { meta: WpResponseMeta; payload: Uint8Array } | null {
  const start = WP_RESPONSE_MAGIC.length;
  if (!startsWith(bytes, WP_RESPONSE_MAGIC) || bytes.length < start + 4) return null;
  const length = readUint32(bytes, start);
  if (length > 4096 || bytes.length < start + 4 + length) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(start + 4, start + 4 + length),
      ),
    );
  } catch {
    return null;
  }
  if (typeof meta !== 'object' || meta === null) return null;
  const { ts, status, sig } = meta as Record<string, unknown>;
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0) return null;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return null;
  }
  if (typeof sig !== 'string' || !/^([A-Za-z0-9_-]{86})?$/.test(sig)) return null;
  return { meta: { ts, status, sig }, payload: bytes.subarray(start + 4 + length) };
}

const BOUNDARY = /^[A-Za-z0-9_-]{16,70}$/;

/**
 * The multipart/form-data request body: the `rn_auth` field, then the `bundle` file part. The
 * boundary must be random (24 bytes of base64url is plenty), which is what keeps it out of the
 * gzip bytes.
 */
export function encodeWpMultipart(
  auth: string,
  gzippedFrame: Uint8Array,
  boundary: string,
): { contentType: string; body: Uint8Array } {
  if (!BOUNDARY.test(boundary))
    throw new Error('A multipart boundary is 16 to 70 safe characters.');
  if (/[\r\n"]/.test(auth)) throw new Error('rn_auth cannot hold quotes or line breaks.');
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${WP_AUTH_FIELD}"\r\n\r\n` +
    `${auth}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${WP_BUNDLE_FIELD}"; filename="${WP_BUNDLE_FILENAME}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n';
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: concat([ascii(head), gzippedFrame, ascii(tail)]),
  };
}
