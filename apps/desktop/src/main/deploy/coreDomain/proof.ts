import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { signMessage } from '../auth/deviceKey';

/**
 * The device proof for the core domain behind Cloudflare (E44, Cloudflare mode). Cloudflare ends
 * TLS at its edge, so the device certificate never reaches nginx; instead each request carries a
 * header signed with this computer's device key. The signature covers the method, the target
 * (percent-decoded, since Cloudflare may change how a URL is encoded on the way through), the
 * domain, the time and a nonce. The core builds the same text (its DeviceProof.Message) and takes
 * each nonce once.
 */

export const PROOF_HEADER = 'X-Runova-Device-Proof';
const PROOF_VERSION = 'v1';
const PROOF_PREFIX = 'runova-core/core-domain-request';

/** A request head is a few hundred bytes; one this large is not one the app sent. */
const MAX_HEAD_BYTES = 64 * 1024;

export interface ProofKey {
  deviceId: string;
  privateKeyPem: string;
}

/** The target as the core compares it: percent-decoded, or as sent when it does not decode. */
export function decodedTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** The exact text the core verifies. */
export function coreDomainProofMessage(
  deviceId: string,
  method: string,
  target: string,
  domain: string,
  unixMs: number,
  nonce: string,
): string {
  return [
    PROOF_PREFIX,
    PROOF_VERSION,
    deviceId.toLowerCase(),
    method.toUpperCase(),
    decodedTarget(target),
    domain.toLowerCase(),
    String(unixMs),
    nonce,
  ].join('\n');
}

/** The header's value for one request. */
export function coreDomainProof(
  key: ProofKey,
  method: string,
  target: string,
  domain: string,
  unixMs: number,
  nonce: string = randomBytes(16).toString('base64url'),
): string {
  const deviceId = key.deviceId.toLowerCase();
  const message = coreDomainProofMessage(deviceId, method, target, domain, unixMs, nonce);
  return [
    PROOF_VERSION,
    deviceId,
    String(unixMs),
    nonce,
    signMessage(key.privateKeyPem, message),
  ].join('.');
}

/**
 * Adds the proof to the one request a stream carries. Every stream from a transport carries a
 * single request (REST runs without keep-alive, and the hub's WebSocket is one upgrade), so the
 * first head written is the only one to sign. The head is held until it is complete, the proof is
 * added as its last header, and everything after it (a body, WebSocket frames) passes untouched.
 */
export function signFirstRequest<T extends Duplex>(
  stream: T,
  proof: (method: string, target: string) => string,
): T {
  type Write = (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;
  const write = stream.write.bind(stream) as Write;
  let pending: Buffer | null = Buffer.alloc(0);
  const patched: Write = (chunk, encoding, callback) => {
    if (pending === null) return write(chunk, encoding, callback);
    const done = typeof encoding === 'function' ? encoding : callback;
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
        : Buffer.from(chunk as Uint8Array);
    pending = Buffer.concat([pending, bytes]);
    const end = pending.indexOf('\r\n\r\n');
    if (end < 0) {
      if (pending.length > MAX_HEAD_BYTES) {
        pending = null;
        stream.destroy(new Error('The request head grew too large to sign.'));
        return false;
      }
      if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
      return true;
    }
    const head = pending.subarray(0, end).toString('latin1');
    const rest = pending.subarray(end);
    pending = null;
    const [method = 'GET', target = '/'] = (head.split('\r\n')[0] ?? '').split(' ');
    const signed = Buffer.concat([
      Buffer.from(`${head}\r\n${PROOF_HEADER}: ${proof(method, target)}`, 'latin1'),
      rest,
    ]);
    return write(signed, done);
  };
  // end(chunk) writes through Writable's internals, not through write(), so it is routed here.
  type End = (chunk?: unknown, encoding?: unknown, callback?: unknown) => T;
  const end = stream.end.bind(stream) as End;
  const patchedEnd: End = (chunk, encoding, callback) => {
    if (pending === null || chunk === undefined || chunk === null || typeof chunk === 'function') {
      return end(chunk, encoding, callback);
    }
    patched(chunk, typeof encoding === 'string' ? encoding : undefined);
    return end(typeof encoding === 'function' ? encoding : callback);
  };
  (stream as unknown as { write: Write; end: End }).write = patched;
  (stream as unknown as { write: Write; end: End }).end = patchedEnd;
  return stream;
}
