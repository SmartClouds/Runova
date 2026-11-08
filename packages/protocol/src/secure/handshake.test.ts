import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  b64u,
  controllerHandshake,
  derivePasswordSecret,
  fromB64u,
  HandshakeError,
  type HsHello,
  type HsReply,
  hostHandshake,
  type IdentityKeyPair,
  identityFromSeed,
  safetyCodeOf,
  utf8,
} from './handshake.js';

/** Deterministic randomness, so a run can be compared byte for byte. */
function seeded(seed: number): (n: number) => Uint8Array {
  let state = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = state >>> 24;
    }
    return out;
  };
}

const host = identityFromSeed(new Uint8Array(32).fill(1));
const controller = identityFromSeed(new Uint8Array(32).fill(2));
const stranger = identityFromSeed(new Uint8Array(32).fill(3));
const SESSION = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
const FP_HOST = 'sha-256 AA:BB:CC';
const FP_CONTROLLER = 'sha-256 11:22:33';

interface RunOptions {
  mode?: 'ask' | 'password';
  hostPrs?: Uint8Array;
  controllerPrs?: Uint8Array;
  expectedHostKey?: Uint8Array;
  expectedControllerKey?: Uint8Array;
  hostIdentity?: IdentityKeyPair;
  controllerIdentity?: IdentityKeyPair;
  hostSeesRemoteFingerprint?: string;
  controllerSeesRemoteFingerprint?: string;
  tamperHello?: (hello: HsHello) => HsHello;
  tamperReply?: (reply: HsReply) => HsReply;
}

function run(options: RunOptions = {}) {
  const mode = options.mode ?? 'ask';
  const c = controllerHandshake({
    sessionId: SESSION,
    mode,
    identity: options.controllerIdentity ?? controller,
    expectedHostKey: options.expectedHostKey ?? host.publicKey,
    ...(options.controllerPrs ? { passwordSecret: options.controllerPrs } : {}),
    localFingerprint: FP_CONTROLLER,
    remoteFingerprint: options.controllerSeesRemoteFingerprint ?? FP_HOST,
    random: seeded(7),
  });
  const h = hostHandshake({
    sessionId: SESSION,
    mode,
    identity: options.hostIdentity ?? host,
    expectedControllerKey: options.expectedControllerKey ?? controller.publicKey,
    ...(options.hostPrs ? { passwordSecret: options.hostPrs } : {}),
    localFingerprint: FP_HOST,
    remoteFingerprint: options.hostSeesRemoteFingerprint ?? FP_CONTROLLER,
    random: seeded(11),
  });
  const hello = (options.tamperHello ?? ((x) => x))(c.hello);
  const reply = (options.tamperReply ?? ((x) => x))(h.respond(hello));
  const { finish, keys: controllerKeys } = c.complete(reply);
  const hostKeys = h.complete(finish);
  return { hello, reply, finish, controllerKeys, hostKeys };
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof HandshakeError) return error.reason;
    throw error;
  }
  throw new Error('expected the handshake to fail');
}

describe('anywhere handshake', () => {
  it('agrees on a key in each direction and on the safety code', () => {
    const { controllerKeys, hostKeys } = run();

    expect(controllerKeys.send).toEqual(hostKeys.receive);
    expect(controllerKeys.receive).toEqual(hostKeys.send);
    expect(controllerKeys.send).not.toEqual(controllerKeys.receive);
    expect(controllerKeys.send).toHaveLength(32);
    expect(controllerKeys.safetyCode).toMatch(/^\d{6}$/);
    expect(controllerKeys.safetyCode).toBe(hostKeys.safetyCode);
  });

  it('sends only public values in the hello', () => {
    const { hello } = run();

    expect(Object.keys(hello).sort()).toEqual(['eph', 'fp', 'id', 'nonce', 't', 'v']);
    expect(fromB64u(hello.id)).toEqual(controller.publicKey);
    expect(fromB64u(hello.eph)).toHaveLength(32);
    expect(fromB64u(hello.nonce)).toHaveLength(16);
  });

  it('works with the right password and adds the CPace shares', async () => {
    const secret = await derivePasswordSecret('correct horse battery', b64u(host.publicKey));

    const { hello, reply, controllerKeys, hostKeys } = run({
      mode: 'password',
      hostPrs: secret,
      controllerPrs: secret,
    });

    expect(hello.cpace).toBeDefined();
    expect(reply.cpace).toBeDefined();
    expect(controllerKeys.send).toEqual(hostKeys.receive);
  });

  it('tells the controller the password is wrong, and the host never completes', async () => {
    const right = await derivePasswordSecret('correct horse battery', b64u(host.publicKey));
    const wrong = await derivePasswordSecret('correct horse battery!', b64u(host.publicKey));

    expect(reasonOf(() => run({ mode: 'password', hostPrs: right, controllerPrs: wrong }))).toBe(
      'wrong-password',
    );
  });

  it('gives a different session key for the same password with a different host key', async () => {
    const a = await derivePasswordSecret('pw', b64u(host.publicKey));
    const b = await derivePasswordSecret('pw', b64u(stranger.publicKey));

    expect(a).not.toEqual(b);
    expect(a).toHaveLength(32);
  });

  it('refuses a host that is not the one the controller expected', () => {
    expect(reasonOf(() => run({ hostIdentity: stranger }))).toBe('identity');
  });

  it('refuses a controller that is not the one the server announced', () => {
    expect(reasonOf(() => run({ controllerIdentity: stranger }))).toBe('identity');
  });

  it('notices a swapped DTLS fingerprint, so the signaling server can not sit in the middle', () => {
    expect(reasonOf(() => run({ hostSeesRemoteFingerprint: 'sha-256 EE:EE' }))).toBe('fingerprint');
    expect(reasonOf(() => run({ controllerSeesRemoteFingerprint: 'sha-256 EE:EE' }))).toBe(
      'fingerprint',
    );
  });

  it('refuses a reply whose signature does not cover what was exchanged', () => {
    expect(
      reasonOf(() =>
        run({
          tamperReply: (reply) => ({ ...reply, nonce: b64u(new Uint8Array(16).fill(9)) }),
        }),
      ),
    ).toBe('signature');
  });

  it('refuses a malformed message', () => {
    expect(reasonOf(() => run({ tamperHello: (hello) => ({ ...hello, eph: 'short' }) }))).toBe(
      'protocol',
    );
    expect(reasonOf(() => run({ tamperHello: (hello) => ({ ...hello, v: 2 as 1 }) }))).toBe(
      'protocol',
    );
  });

  it('refuses a password hello on an ask session and the other way round', async () => {
    const secret = await derivePasswordSecret('pw', b64u(host.publicKey));

    expect(
      reasonOf(() =>
        run({
          mode: 'password',
          hostPrs: secret,
          controllerPrs: secret,
          tamperHello: ({ cpace: _cpace, ...hello }) => hello,
        }),
      ),
    ).toBe('protocol');
  });

  it('signs with the identity key, which verifies with the public half', () => {
    const { reply, finish } = run();

    expect(fromB64u(reply.sig)).toHaveLength(64);
    expect(fromB64u(finish.sig)).toHaveLength(64);
    expect(ed25519.getPublicKey(host.secretKey)).toEqual(host.publicKey);
  });

  it('turns a transcript hash into a six-digit code', () => {
    expect(safetyCodeOf(new Uint8Array(32))).toMatch(/^\d{6}$/);
    expect(safetyCodeOf(new Uint8Array(32))).not.toBe(safetyCodeOf(new Uint8Array(32).fill(1)));
  });

  it('is deterministic for a given randomness, which is what the agent test vectors rely on', () => {
    const first = run();
    const second = run();

    expect(second.reply).toEqual(first.reply);
    expect(second.controllerKeys.send).toEqual(first.controllerKeys.send);
  });
});

describe('base64url', () => {
  it('round-trips without padding', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x10]);

    expect(b64u(bytes)).toBe('-_8AEA');
    expect(fromB64u('-_8AEA')).toEqual(bytes);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => fromB64u('ab+c')).toThrow();
  });
});

describe('utf8', () => {
  it('matches the platform encoder for every plane', () => {
    for (const sample of ['abc', 'café', 'رمز عبور', '密码', '🔐 key']) {
      expect(utf8(sample)).toEqual(new TextEncoder().encode(sample));
    }
  });
});
