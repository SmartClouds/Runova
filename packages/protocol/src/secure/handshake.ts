/**
 * The Runova Anywhere handshake (E61). Two computers that found each other through the
 * website's hub run it over their link, before any screen data, and come out with one key in each
 * direction, a six-digit safety code, and proof of who is on the other end.
 *
 * - Each side has an Ed25519 identity key. The server only vouches for which account a key belongs
 *   to; each side signs the whole transcript with its key, and the controller pins the host's key.
 * - Each side sends a fresh X25519 key; the shared secret is fresh for every session.
 * - Over WebRTC, the transcript carries both DTLS fingerprints as each side saw them, so a
 *   signaling server that swapped them to sit in the middle would break the signatures.
 * - In password mode both sides also run CPace over ristretto255 with a secret derived from the
 *   password. The password never leaves the controller, the host keeps only the derived secret,
 *   and a wrong guess teaches an attacker nothing it could test offline.
 *
 * It is sans-IO and takes its randomness from outside, so the native agent can be checked against
 * the same test vectors byte for byte. Every length-prefixed field is a big-endian u32 length
 * followed by the bytes; strings are UTF-8.
 */
import { ed25519, ristretto255, ristretto255_hasher, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

export const HANDSHAKE_VERSION = 1;
const DOMAIN = 'runova-anywhere-v1';
const CPACE_DSI = 'CPaceRistretto255';
const CPACE_ISK_DSI = 'CPaceRistretto255_ISK';
/** scrypt cost for the password secret: about 100 ms on a laptop, 32 MiB of memory. */
export const PASSWORD_SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

export type AccessMode = 'ask' | 'password';

export interface HsHello {
  t: 'hs-hello';
  v: 1;
  /** The controller's X25519 key for this session. */
  eph: string;
  /** The controller's Ed25519 identity key. */
  id: string;
  nonce: string;
  /** The controller's own DTLS fingerprint, or empty off WebRTC. */
  fp: string;
  /** The controller's CPace share, in password mode only. */
  cpace?: string;
}

export interface HsReply {
  t: 'hs-reply';
  eph: string;
  id: string;
  nonce: string;
  fp: string;
  cpace?: string;
  sig: string;
  confirm: string;
}

export interface HsFinish {
  t: 'hs-finish';
  sig: string;
  confirm: string;
}

export type HandshakeFailure =
  | 'protocol'
  | 'identity'
  | 'fingerprint'
  | 'signature'
  | 'wrong-password';

/** Tells the other side why the handshake stopped, so the host can count a wrong password at once. */
export interface HsAbort {
  t: 'hs-abort';
  reason: HandshakeFailure;
}

export type HandshakeMessage = HsHello | HsReply | HsFinish | HsAbort;

export class HandshakeError extends Error {
  constructor(
    readonly reason: HandshakeFailure,
    message?: string,
  ) {
    super(message ?? `The secure handshake failed (${reason}).`);
    this.name = 'HandshakeError';
  }
}

export interface IdentityKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface SessionKeys {
  /** For what this side sends. */
  send: Uint8Array;
  /** For what the other side sends. */
  receive: Uint8Array;
  /** Six digits both people can compare to be sure no one is in the middle. */
  safetyCode: string;
  transcript: Uint8Array;
}

interface CommonOptions {
  sessionId: string;
  mode: AccessMode;
  identity: IdentityKeyPair;
  /** From {@link derivePasswordSecret}, in password mode. */
  passwordSecret?: Uint8Array;
  /** This side's DTLS fingerprint as in its SDP, or empty off WebRTC. */
  localFingerprint?: string;
  /** The other side's DTLS fingerprint as this side received it, or empty off WebRTC. */
  remoteFingerprint?: string;
  random?: (length: number) => Uint8Array;
}

export interface ControllerOptions extends CommonOptions {
  /** The host's identity key: the one the server gave, or the one pinned on an earlier connection. */
  expectedHostKey: Uint8Array;
}

export interface HostOptions extends CommonOptions {
  /** The controller's identity key, as the server announced it with the request. */
  expectedControllerKey: Uint8Array;
}

export function identityFromSeed(seed: Uint8Array): IdentityKeyPair {
  if (seed.length !== 32) throw new Error('An identity seed is 32 bytes.');
  return { secretKey: seed, publicKey: ed25519.getPublicKey(seed) };
}

export function newIdentity(): IdentityKeyPair {
  return identityFromSeed(ed25519.utils.randomSecretKey());
}

/**
 * The secret both sides use for CPace, from the password and the host's identity key. The host
 * stores this (sealed), never the password; the controller derives it when the person types.
 */
export async function derivePasswordSecret(
  password: string,
  hostIdentityKey: string,
): Promise<Uint8Array> {
  return scryptAsync(
    utf8(password.normalize('NFKC')),
    utf8(`runova-anywhere-prs-v1|${hostIdentityKey}`),
    PASSWORD_SCRYPT,
  );
}

export function controllerHandshake(options: ControllerOptions): {
  hello: HsHello;
  complete(reply: HsReply): { finish: HsFinish; keys: SessionKeys };
} {
  const random = options.random ?? randomBytes;
  const eph = random(32);
  const ephPublic = x25519.getPublicKey(eph);
  const nonce = random(16);
  const cpace =
    options.mode === 'password'
      ? cpaceShare(options, options.identity.publicKey, options.expectedHostKey, random)
      : null;
  const hello: HsHello = {
    t: 'hs-hello',
    v: HANDSHAKE_VERSION,
    eph: b64u(ephPublic),
    id: b64u(options.identity.publicKey),
    nonce: b64u(nonce),
    fp: options.localFingerprint ?? '',
    ...(cpace ? { cpace: b64u(cpace.share) } : {}),
  };

  return {
    hello,
    complete(reply) {
      if (reply?.t !== 'hs-reply') throw new HandshakeError('protocol');
      const hostEph = key32(reply.eph);
      const hostId = key32(reply.id);
      const hostNonce = bytes(reply.nonce, 16);
      if (!equalBytes(hostId, options.expectedHostKey)) throw new HandshakeError('identity');
      if (reply.fp !== (options.remoteFingerprint ?? '')) throw new HandshakeError('fingerprint');
      const hostShare = options.mode === 'password' ? point(reply.cpace) : null;
      if (options.mode !== 'password' && reply.cpace !== undefined)
        throw new HandshakeError('protocol');

      const transcript = transcriptOf({
        sessionId: options.sessionId,
        mode: options.mode,
        controllerId: options.identity.publicKey,
        hostId,
        controllerEph: ephPublic,
        hostEph,
        controllerNonce: nonce,
        hostNonce,
        controllerFp: hello.fp,
        hostFp: reply.fp,
        controllerShare: cpace?.share ?? null,
        hostShare: hostShare?.toBytes() ?? null,
      });
      if (!verify(reply.sig, 'host', transcript, hostId)) throw new HandshakeError('signature');

      const isk =
        cpace && hostShare
          ? cpaceIsk(options.sessionId, cpace.scalar, hostShare, cpace.share, hostShare.toBytes())
          : null;
      const derived = deriveKeys(eph, hostEph, isk, transcript);
      if (!equalBytes(fromB64u(reply.confirm), confirmOf(derived.confirmKey, 'host', transcript))) {
        throw new HandshakeError(options.mode === 'password' ? 'wrong-password' : 'protocol');
      }

      return {
        finish: {
          t: 'hs-finish',
          sig: b64u(sign('controller', transcript, options.identity.secretKey)),
          confirm: b64u(confirmOf(derived.confirmKey, 'controller', transcript)),
        },
        keys: {
          send: derived.controllerToHost,
          receive: derived.hostToController,
          safetyCode: safetyCodeOf(transcript),
          transcript,
        },
      };
    },
  };
}

export function hostHandshake(options: HostOptions): {
  respond(hello: HsHello): HsReply;
  complete(finish: HsFinish): SessionKeys;
} {
  const random = options.random ?? randomBytes;
  let pending: {
    transcript: Uint8Array;
    controllerId: Uint8Array;
    keys: ReturnType<typeof deriveKeys>;
  } | null = null;

  return {
    respond(hello) {
      if (hello?.t !== 'hs-hello' || hello.v !== HANDSHAKE_VERSION)
        throw new HandshakeError('protocol');
      const controllerEph = key32(hello.eph);
      const controllerId = key32(hello.id);
      const controllerNonce = bytes(hello.nonce, 16);
      if (!equalBytes(controllerId, options.expectedControllerKey))
        throw new HandshakeError('identity');
      if (hello.fp !== (options.remoteFingerprint ?? '')) throw new HandshakeError('fingerprint');
      if ((options.mode === 'password') !== (hello.cpace !== undefined))
        throw new HandshakeError('protocol');
      const controllerShare = options.mode === 'password' ? point(hello.cpace) : null;

      const eph = random(32);
      const ephPublic = x25519.getPublicKey(eph);
      const nonce = random(16);
      const cpace =
        options.mode === 'password'
          ? cpaceShare(options, controllerId, options.identity.publicKey, random)
          : null;
      const reply = {
        t: 'hs-reply',
        eph: b64u(ephPublic),
        id: b64u(options.identity.publicKey),
        nonce: b64u(nonce),
        fp: options.localFingerprint ?? '',
        ...(cpace ? { cpace: b64u(cpace.share) } : {}),
      } as const;

      const transcript = transcriptOf({
        sessionId: options.sessionId,
        mode: options.mode,
        controllerId,
        hostId: options.identity.publicKey,
        controllerEph,
        hostEph: ephPublic,
        controllerNonce,
        hostNonce: nonce,
        controllerFp: hello.fp,
        hostFp: reply.fp,
        controllerShare: controllerShare?.toBytes() ?? null,
        hostShare: cpace?.share ?? null,
      });
      const isk =
        cpace && controllerShare
          ? cpaceIsk(
              options.sessionId,
              cpace.scalar,
              controllerShare,
              controllerShare.toBytes(),
              cpace.share,
            )
          : null;
      const keys = deriveKeys(eph, controllerEph, isk, transcript);
      pending = { transcript, controllerId, keys };
      return {
        ...reply,
        sig: b64u(sign('host', transcript, options.identity.secretKey)),
        confirm: b64u(confirmOf(keys.confirmKey, 'host', transcript)),
      };
    },
    complete(finish) {
      if (!pending || finish?.t !== 'hs-finish') throw new HandshakeError('protocol');
      const { transcript, controllerId, keys } = pending;
      if (!verify(finish.sig, 'controller', transcript, controllerId))
        throw new HandshakeError('signature');
      if (
        !equalBytes(fromB64u(finish.confirm), confirmOf(keys.confirmKey, 'controller', transcript))
      ) {
        throw new HandshakeError(options.mode === 'password' ? 'wrong-password' : 'protocol');
      }
      return {
        send: keys.hostToController,
        receive: keys.controllerToHost,
        safetyCode: safetyCodeOf(transcript),
        transcript,
      };
    },
  };
}

/** Six digits from the transcript hash. A different transcript on each side gives different codes. */
export function safetyCodeOf(transcript: Uint8Array): string {
  const digest = sha256(concat(utf8(`${DOMAIN} safety`), transcript));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}

// --- CPace -----------------------------------------------------------------------

type RPoint = InstanceType<typeof ristretto255.Point>;

function cpaceShare(
  options: CommonOptions,
  controllerId: Uint8Array,
  hostId: Uint8Array,
  random: (length: number) => Uint8Array,
): { scalar: bigint; share: Uint8Array } {
  if (!options.passwordSecret)
    throw new HandshakeError('protocol', 'Password mode needs the password secret.');
  const generator = ristretto255_hasher.deriveToCurve!(
    sha512(
      concat(
        lv(utf8(CPACE_DSI)),
        lv(options.passwordSecret),
        lv(concat(lv(controllerId), lv(hostId))),
        lv(utf8(options.sessionId)),
      ),
    ),
  );
  const scalar = randomScalar(random);
  const share = generator.multiply(scalar);
  return { scalar, share: share.toBytes() };
}

/**
 * ISK = SHA-512(lv(DSI) || lv(sid) || lv(K) || lv(Ya) || lv(Yb)), with Ya the controller's share,
 * Yb the host's, and K this side's scalar times the other side's share.
 */
function cpaceIsk(
  sessionId: string,
  scalar: bigint,
  peer: RPoint,
  ya: Uint8Array,
  yb: Uint8Array,
): Uint8Array {
  const shared = peer.multiply(scalar);
  if (shared.is0()) throw new HandshakeError('protocol');
  return sha512(
    concat(lv(utf8(CPACE_ISK_DSI)), lv(utf8(sessionId)), lv(shared.toBytes()), lv(ya), lv(yb)),
  );
}

function randomScalar(random: (length: number) => Uint8Array): bigint {
  const n = ristretto255.Point.Fn.ORDER;
  for (;;) {
    const wide = random(64);
    let value = 0n;
    for (let i = wide.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(wide[i]);
    const scalar = value % n;
    if (scalar !== 0n) return scalar;
  }
}

function point(value: string | undefined): RPoint {
  if (typeof value !== 'string') throw new HandshakeError('protocol');
  try {
    const decoded = ristretto255.Point.fromBytes(bytes(value, 32));
    if (decoded.is0()) throw new HandshakeError('protocol');
    return decoded;
  } catch {
    throw new HandshakeError('protocol');
  }
}

// --- Keys ------------------------------------------------------------------------

function deriveKeys(
  eph: Uint8Array,
  peerEph: Uint8Array,
  isk: Uint8Array | null,
  transcript: Uint8Array,
) {
  let dh: Uint8Array;
  try {
    dh = x25519.getSharedSecret(eph, peerEph);
  } catch {
    throw new HandshakeError('protocol');
  }
  if (dh.every((b) => b === 0)) throw new HandshakeError('protocol');
  const okm = hkdf(
    sha256,
    concat(dh, isk ?? new Uint8Array()),
    transcript,
    utf8(`${DOMAIN} keys`),
    96,
  );
  return {
    controllerToHost: okm.slice(0, 32),
    hostToController: okm.slice(32, 64),
    confirmKey: okm.slice(64, 96),
  };
}

function transcriptOf(t: {
  sessionId: string;
  mode: AccessMode;
  controllerId: Uint8Array;
  hostId: Uint8Array;
  controllerEph: Uint8Array;
  hostEph: Uint8Array;
  controllerNonce: Uint8Array;
  hostNonce: Uint8Array;
  controllerFp: string;
  hostFp: string;
  controllerShare: Uint8Array | null;
  hostShare: Uint8Array | null;
}): Uint8Array {
  return sha256(
    concat(
      lv(utf8(DOMAIN)),
      lv(utf8(t.sessionId)),
      lv(utf8(t.mode)),
      lv(t.controllerId),
      lv(t.hostId),
      lv(t.controllerEph),
      lv(t.hostEph),
      lv(t.controllerNonce),
      lv(t.hostNonce),
      lv(utf8(t.controllerFp)),
      lv(utf8(t.hostFp)),
      lv(t.controllerShare ?? new Uint8Array()),
      lv(t.hostShare ?? new Uint8Array()),
    ),
  );
}

function sign(
  role: 'host' | 'controller',
  transcript: Uint8Array,
  secretKey: Uint8Array,
): Uint8Array {
  return ed25519.sign(concat(utf8(`${DOMAIN} ${role}`), transcript), secretKey);
}

function verify(
  signature: string,
  role: 'host' | 'controller',
  transcript: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(
      bytes(signature, 64),
      concat(utf8(`${DOMAIN} ${role}`), transcript),
      publicKey,
    );
  } catch {
    return false;
  }
}

function confirmOf(
  confirmKey: Uint8Array,
  role: 'host' | 'controller',
  transcript: Uint8Array,
): Uint8Array {
  return hmac(sha256, confirmKey, concat(utf8(role), transcript));
}

// --- Bytes -----------------------------------------------------------------------

/** UTF-8, written out because the package targets plain ES2022 with no DOM or Node types. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(out);
}

function lv(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  new DataView(out.buffer).setUint32(0, value.length, false);
  out.set(value, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time for equal lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function key32(value: unknown): Uint8Array {
  return bytes(value, 32);
}

function bytes(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string') throw new HandshakeError('protocol');
  let decoded: Uint8Array;
  try {
    decoded = fromB64u(value);
  } catch {
    throw new HandshakeError('protocol');
  }
  if (decoded.length !== length) throw new HandshakeError('protocol');
  return decoded;
}

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding. */
export function b64u(data: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < data.length; i += 3) {
    const n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += B64U[n >> 18] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63] + B64U[n & 63];
  }
  if (i < data.length) {
    const n = (data[i] << 16) | ((data[i + 1] ?? 0) << 8);
    out += B64U[n >> 18] + B64U[(n >> 12) & 63];
    if (i + 1 < data.length) out += B64U[(n >> 6) & 63];
  }
  return out;
}

export function fromB64u(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('Not base64url.');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    value = (value << 6) | B64U.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out.slice(0, index);
}
