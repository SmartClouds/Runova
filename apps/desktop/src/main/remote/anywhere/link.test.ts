import { b64u, derivePasswordSecret, identityFromSeed } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SOCKET_OPEN } from '../peerSocket';
import { type LinkTransport, SecureLink } from './link';

// The real password secret is a 32 MiB scrypt, about 100 ms here and many seconds on a loaded
// runner. These tests are about the link, not the derivation, which @runova/protocol tests at
// its real cost against fixed vectors, so the secret here comes from the same inputs cheaply.
vi.mock('@runova/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@runova/protocol')>();
  const { createHash } = await import('node:crypto');
  return {
    ...actual,
    derivePasswordSecret: async (password: string, hostIdentityKey: string) =>
      new Uint8Array(
        createHash('sha256')
          .update(`${password.normalize('NFKC')}|${hostIdentityKey}`)
          .digest(),
      ),
  };
});

const host = identityFromSeed(new Uint8Array(32).fill(1));
const controller = identityFromSeed(new Uint8Array(32).fill(2));
const stranger = identityFromSeed(new Uint8Array(32).fill(3));

interface FakeEnd extends LinkTransport {
  sent: Uint8Array[];
  connect(other: FakeEnd): void;
  deliver(frame: Uint8Array): void;
  shut(reason: string): void;
}

/** Two transports wired to each other, delivering frames in order on the next tick. */
function pair(): [FakeEnd, FakeEnd] {
  function end(): FakeEnd {
    const frameListeners: ((f: Uint8Array) => void)[] = [];
    const closeListeners: ((r: string) => void)[] = [];
    let other: FakeEnd | null = null;
    let closed = false;
    const self: FakeEnd = {
      sent: [] as Uint8Array[],
      connect(o: FakeEnd) {
        other = o;
      },
      deliver(frame: Uint8Array) {
        if (!closed) for (const l of frameListeners) l(frame);
      },
      shut(reason: string) {
        if (closed) return;
        closed = true;
        for (const l of closeListeners) l(reason);
      },
      send(frame: Uint8Array) {
        self.sent.push(frame);
        const target = other;
        setTimeout(() => target?.deliver(frame), 0);
      },
      bufferedAmount: () => 0,
      close(reason: string) {
        self.shut(reason);
        const target = other;
        setTimeout(() => target?.shut(reason), 0);
      },
      onFrame(listener: (f: Uint8Array) => void) {
        frameListeners.push(listener);
      },
      onClose(listener: (r: string) => void) {
        closeListeners.push(listener);
      },
    };
    return self;
  }
  const a = end();
  const b = end();
  a.connect(b);
  b.connect(a);
  return [a, b];
}

const SESSION = 'session-1';

async function connectBoth(
  options: { password?: [string, string]; hostKeyExpected?: Uint8Array } = {},
) {
  const [ct, ht] = pair();
  const controllerLink = new SecureLink(ct);
  const hostLink = new SecureLink(ht);
  const mode = options.password ? 'password' : 'ask';
  const controllerSecret = options.password
    ? await derivePasswordSecret(options.password[0], b64u(host.publicKey))
    : undefined;
  const hostSecret = options.password
    ? await derivePasswordSecret(options.password[1], b64u(host.publicKey))
    : undefined;
  const hostRun = hostLink.runAsHost({
    sessionId: SESSION,
    mode,
    identity: host,
    expectedControllerKey: controller.publicKey,
    ...(hostSecret ? { passwordSecret: hostSecret } : {}),
  });
  const controllerRun = controllerLink.runAsController({
    sessionId: SESSION,
    mode,
    identity: controller,
    expectedHostKey: options.hostKeyExpected ?? host.publicKey,
    ...(controllerSecret ? { passwordSecret: controllerSecret } : {}),
  });
  return { controllerLink, hostLink, hostRun, controllerRun, ct, ht };
}

function nextMessage(link: SecureLink): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) => link.onMessage((data, isBinary) => resolve({ data, isBinary })));
}

describe('SecureLink', () => {
  it('opens once both sides finish the handshake and agree on a safety code', async () => {
    const { controllerLink, hostLink, hostRun, controllerRun } = await connectBoth();

    const [hostKeys, controllerKeys] = await Promise.all([hostRun, controllerRun]);

    expect(controllerKeys.safetyCode).toBe(hostKeys.safetyCode);
    expect(controllerLink.readyState).toBe(SOCKET_OPEN);
    expect(hostLink.readyState).toBe(SOCKET_OPEN);
  });

  it('carries control and binary messages both ways once open', async () => {
    const { controllerLink, hostLink, hostRun, controllerRun } = await connectBoth();
    await Promise.all([hostRun, controllerRun]);

    const atHost = nextMessage(hostLink);
    controllerLink.send(JSON.stringify({ t: 'ping' }));
    const atController = nextMessage(controllerLink);
    hostLink.send(new Uint8Array([9, 8, 7]), { binary: true });

    expect((await atHost).data.toString()).toBe('{"t":"ping"}');
    expect((await atHost).isBinary).toBe(false);
    expect([...(await atController).data]).toEqual([9, 8, 7]);
    expect((await atController).isBinary).toBe(true);
  });

  it('carries a message larger than one frame', async () => {
    const { controllerLink, hostLink, hostRun, controllerRun } = await connectBoth();
    await Promise.all([hostRun, controllerRun]);
    const big = new Uint8Array(300_000).map((_, i) => i % 256);

    const atHost = nextMessage(hostLink);
    controllerLink.send(big, { binary: true });

    expect(new Uint8Array((await atHost).data)).toEqual(big);
  });

  it('keeps messages that arrive before anyone listens', async () => {
    const { controllerLink, hostLink, hostRun, controllerRun } = await connectBoth();
    await controllerRun;
    controllerLink.send(JSON.stringify({ t: 'hello' }));
    await hostRun;
    await new Promise((r) => setTimeout(r, 5));

    const atHost = await nextMessage(hostLink);

    expect(atHost.data.toString()).toBe('{"t":"hello"}');
  });

  it('calls back on send like a WebSocket does', async () => {
    const { controllerLink, hostRun, controllerRun } = await connectBoth();
    await Promise.all([hostRun, controllerRun]);

    const error = await new Promise<Error | undefined>((resolve) =>
      controllerLink.send(new Uint8Array([1]), { binary: true }, resolve),
    );

    expect(error).toBeUndefined();
  });

  it('fails a wrong password on both sides, and tells the host why', async () => {
    const { hostRun, controllerRun } = await connectBoth({ password: ['right one', 'wrong one'] });

    await expect(controllerRun).rejects.toMatchObject({ reason: 'wrong-password' });
    await expect(hostRun).rejects.toMatchObject({ reason: 'wrong-password' });
  });

  it('works with the right password', async () => {
    const { hostRun, controllerRun } = await connectBoth({ password: ['same', 'same'] });

    await expect(Promise.all([hostRun, controllerRun])).resolves.toHaveLength(2);
  });

  it('refuses a host whose key is not the one expected and closes', async () => {
    const { controllerLink, hostRun, controllerRun } = await connectBoth({
      hostKeyExpected: stranger.publicKey,
    });

    await expect(controllerRun).rejects.toMatchObject({ reason: 'identity' });
    await expect(hostRun).rejects.toBeDefined();
    expect(controllerLink.readyState).not.toBe(SOCKET_OPEN);
  });

  it('drops anything sent before the handshake and does not open', async () => {
    const [ct, ht] = pair();
    const hostLink = new SecureLink(ht);
    const hostRun = hostLink.runAsHost({
      sessionId: SESSION,
      mode: 'ask',
      identity: host,
      expectedControllerKey: controller.publicKey,
    });

    ct.send(
      new Uint8Array([0x01, ...Buffer.from('{"t":"input","event":{"k":"text","text":"rm -rf"}}')]),
    );

    await expect(hostRun).rejects.toMatchObject({ reason: 'protocol' });
    expect(hostLink.readyState).not.toBe(SOCKET_OPEN);
  });

  it('gives up when the other side never answers', async () => {
    const [ct] = pair();
    const controllerLink = new SecureLink(ct, { handshakeTimeoutMs: 20 });

    await expect(
      controllerLink.runAsController({
        sessionId: SESSION,
        mode: 'ask',
        identity: controller,
        expectedHostKey: host.publicKey,
      }),
    ).rejects.toThrow(/did not answer/);
  });

  it('reports closing from either side once', async () => {
    const { controllerLink, hostLink, hostRun, controllerRun } = await connectBoth();
    await Promise.all([hostRun, controllerRun]);
    let closes = 0;
    hostLink.onClose(() => closes++);

    controllerLink.close();
    await new Promise((r) => setTimeout(r, 10));
    controllerLink.close();
    await new Promise((r) => setTimeout(r, 10));

    expect(closes).toBe(1);
    expect(hostLink.readyState).not.toBe(SOCKET_OPEN);
  });

  it('seals every frame after the handshake when a cipher is given', async () => {
    const [ct, ht] = pair();
    const seal = (frame: Uint8Array) => Uint8Array.from(frame, (b) => b ^ 0x5a);
    const cipher = () => ({ seal, open: seal });
    const controllerLink = new SecureLink(ct, { cipher });
    const hostLink = new SecureLink(ht, { cipher });
    await Promise.all([
      hostLink.runAsHost({
        sessionId: SESSION,
        mode: 'ask',
        identity: host,
        expectedControllerKey: controller.publicKey,
      }),
      controllerLink.runAsController({
        sessionId: SESSION,
        mode: 'ask',
        identity: controller,
        expectedHostKey: host.publicKey,
      }),
    ]);

    const atHost = nextMessage(hostLink);
    controllerLink.send(JSON.stringify({ t: 'secret' }));

    expect((await atHost).data.toString()).toBe('{"t":"secret"}');
    expect(Buffer.from(ct.sent.at(-1) ?? []).toString()).not.toContain('secret');
  });
});
