import { createCipheriv, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeLinkMessage, LINK_BINARY, LINK_TEXT } from '../link.js';
import {
  b64u,
  controllerHandshake,
  derivePasswordSecret,
  hostHandshake,
  identityFromSeed,
} from './handshake.js';

/**
 * Test vectors for the Runova Anywhere handshake, link framing and relay cipher (E64). The native
 * agent implements the same protocol in C# and its tests replay these byte for byte, so the two
 * can never drift apart unnoticed. Each side's randomness is recorded in the order it is used.
 *
 * Run with UPDATE_VECTORS=1 to write the file after a deliberate protocol change; otherwise this
 * checks the committed file still matches what the code produces.
 */

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '..', '..', 'test-vectors', 'anywhere-v1.json');

function recorder(seed: number) {
  let state = seed >>> 0;
  const used: string[] = [];
  return {
    used,
    random(n: number): Uint8Array {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        out[i] = state >>> 24;
      }
      used.push(Buffer.from(out).toString('hex'));
      return out;
    },
  };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function handshakeVector(mode: 'ask' | 'password') {
  const host = identityFromSeed(new Uint8Array(32).fill(0x11));
  const controller = identityFromSeed(new Uint8Array(32).fill(0x22));
  const sessionId = 'Zm9vYmFyYmF6cXV4cXV1eA';
  const password = 'correct horse battery staple';
  const passwordSecret =
    mode === 'password' ? await derivePasswordSecret(password, b64u(host.publicKey)) : undefined;
  const c = recorder(1);
  const h = recorder(2);
  const controllerSide = controllerHandshake({
    sessionId,
    mode,
    identity: controller,
    expectedHostKey: host.publicKey,
    ...(passwordSecret ? { passwordSecret } : {}),
    localFingerprint: 'sha-256 AA:BB',
    remoteFingerprint: 'sha-256 CC:DD',
    random: c.random,
  });
  const hostSide = hostHandshake({
    sessionId,
    mode,
    identity: host,
    expectedControllerKey: controller.publicKey,
    ...(passwordSecret ? { passwordSecret } : {}),
    localFingerprint: 'sha-256 CC:DD',
    remoteFingerprint: 'sha-256 AA:BB',
    random: h.random,
  });
  const reply = hostSide.respond(controllerSide.hello);
  const { finish, keys } = controllerSide.complete(reply);
  const hostKeys = hostSide.complete(finish);
  return {
    mode,
    sessionId,
    hostSeed: hex(host.secretKey),
    controllerSeed: hex(controller.secretKey),
    password: mode === 'password' ? password : null,
    passwordSecret: passwordSecret ? hex(passwordSecret) : null,
    controllerFingerprint: 'sha-256 AA:BB',
    hostFingerprint: 'sha-256 CC:DD',
    controllerRandom: c.used,
    hostRandom: h.used,
    hello: controllerSide.hello,
    reply,
    finish,
    controllerToHost: hex(keys.send),
    hostToController: hex(hostKeys.send),
    safetyCode: keys.safetyCode,
    transcript: hex(keys.transcript),
  };
}

function framingVector() {
  const text = Buffer.from(
    '{"t":"auth-ok","deviceName":"SAM-DESK","screen":{"width":1920,"height":1080}}',
  );
  const big = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
  const frames = encodeLinkMessage(LINK_BINARY, big, 42);
  return {
    textPayload: hex(text),
    textFrames: encodeLinkMessage(LINK_TEXT, text, 1).map(hex),
    // The binary payload is byte i = (i * 7) % 256, 70,000 bytes long; frames are kept as their
    // headers and hashes so the file stays small.
    binaryLength: big.length,
    binaryMessageId: 42,
    binaryFrameHeaders: frames.map((f) => hex(f.subarray(0, 10))),
    binaryFrameLengths: frames.map((f) => f.length),
    binaryFrameSha256: frames.map((f) => createHash('sha256').update(f).digest('hex')),
  };
}

function cipherVector() {
  const key = Buffer.alloc(32, 0x5a);
  const frames = ['01', '02deadbeef', hex(new Uint8Array(100).fill(9))];
  const sealed = frames.map((frame, counter) => {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(counter), 4);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(BigInt(counter));
    const body = Buffer.concat([cipher.update(Buffer.from(frame, 'hex')), cipher.final()]);
    return Buffer.concat([head, body, cipher.getAuthTag()]).toString('hex');
  });
  return { key: key.toString('hex'), frames, sealed };
}

// The password tests run the real scrypt (32 MiB, PASSWORD_SCRYPT) in plain JavaScript, twice per
// handshake, and coverage slows it further. That took 12 to 30 s on a busy CI Mac, past the 5 s
// default.
describe('Anywhere test vectors for the native agent', { timeout: 60_000 }, () => {
  it('match the committed file', async () => {
    const vectors = {
      version: 1,
      handshake: [await handshakeVector('ask'), await handshakeVector('password')],
      framing: framingVector(),
      cipher: cipherVector(),
    };
    const json = `${JSON.stringify(vectors, null, 2)}\n`;
    if (process.env.UPDATE_VECTORS === '1' || !existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, json);
    }
    expect(readFileSync(file, 'utf-8')).toBe(json);
  });
});
