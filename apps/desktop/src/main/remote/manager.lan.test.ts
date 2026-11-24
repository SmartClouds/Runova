import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { electronState, resetElectronMock, setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';

/**
 * The LAN side of remote control, with the real token store, file handlers and secure link, over
 * an in-memory stand-in for `ws` that carries the bytes each end sends. The rules that matter
 * here: no token ever crosses the wire readable, a controller only signs in to the host whose key
 * the pairing code named, a host never gets to touch the files of the computer controlling it,
 * and a paired device can be taken off the list for good.
 */

const injector = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  apply: vi.fn(),
  isSupported: vi.fn(() => true),
}));
vi.mock('./inputInjector', () => ({
  InputInjector: class {
    start = injector.start;
    stop = injector.stop;
    apply = injector.apply;
    isSupported = injector.isSupported;
  },
}));

vi.mock('../ipc/send', () => ({ sendToWindow: () => undefined }));

interface Wire {
  readyState: number;
  bufferedAmount: number;
  peer: Wire | null;
  /** Every message this end put on the wire, exactly as it went. */
  out: Buffer[];
  emit(event: string, ...args: unknown[]): boolean;
  send(data: string | Uint8Array): void;
  close(): void;
}

const net = vi.hoisted(() => ({
  servers: [] as { emit(event: string, ...args: unknown[]): boolean }[],
  clients: [] as Wire[],
}));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWire extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    binaryType = 'nodebuffer';
    peer: FakeWire | null = null;
    readonly out: Buffer[] = [];
    send(data: string | Uint8Array, _o?: unknown, cb?: (err?: Error) => void): void {
      const bytes = Buffer.from(data);
      const isBinary = typeof data !== 'string';
      this.out.push(bytes);
      const peer = this.peer;
      queueMicrotask(() => {
        if (peer && peer.readyState !== 3) peer.emit('message', bytes, isBinary);
      });
      if (typeof cb === 'function') cb();
    }
    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', 1000, Buffer.alloc(0));
      // Like a real socket, the other end still gets what was sent before the close.
      const peer = this.peer;
      queueMicrotask(() => peer?.close());
    }
    terminate(): void {
      this.close();
    }
  }
  class WebSocket extends FakeWire {
    constructor(readonly url: string) {
      super();
      net.clients.push(this);
    }
  }
  class WebSocketServer extends EventEmitter {
    constructor() {
      super();
      net.servers.push(this);
    }
    close(): void {
      // Nothing is bound, so there is nothing to release.
    }
  }
  return { WebSocket, WebSocketServer, FakeWire };
});

const ws = (await import('ws')) as unknown as { FakeWire: new () => Wire };
const { RemoteManager } = await import('./manager');
const { LAN_SESSION_ID, lanLink } = await import('./lanLink');
const { b64u, decodePairingCode, encodeFileChunk, fromB64u, newIdentity, transferKeyFromId } =
  await import('../../shared/remoteProtocol');

type Link = ReturnType<typeof lanLink>;
type Message = Record<string, unknown>;

/** The test's side of one connection, once the secure handshake is through. */
class End {
  readonly received: (Message | Uint8Array)[] = [];
  constructor(
    readonly wire: Wire,
    readonly link: Link,
  ) {
    link.onMessage((data, isBinary) => {
      this.received.push(
        isBinary ? new Uint8Array(data) : (JSON.parse(data.toString('utf-8')) as Message),
      );
    });
  }
  send(message: Message): void {
    this.link.send(JSON.stringify(message));
  }
  sendBinary(bytes: Uint8Array): void {
    this.link.send(bytes, { binary: true });
  }
  controls(t: string): Message[] {
    return this.received.filter((m): m is Message => !(m instanceof Uint8Array) && m.t === t);
  }
  last(t: string): Message | undefined {
    return this.controls(t).at(-1);
  }
}

/** Two fake sockets joined, so what one sends the other receives. */
function joined(a: Wire, b: Wire): void {
  a.peer = b;
  b.peer = a;
}

function linkOn(wire: Wire): Link {
  return lanLink(wire as unknown as Parameters<typeof lanLink>[0]);
}

/** Everything both ends of a connection put on the wire, as one string to search. */
function wireText(...wires: Wire[]): string {
  return Buffer.concat(wires.flatMap((w) => w.out)).toString('latin1');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

let downloads = '';
let userData = '';

beforeEach(() => {
  resetElectronMock();
  userData = tempDir('runova-lan-');
  setElectronPath('userData', userData);
  downloads = tempDir('runova-lan-downloads-');
  setElectronPath('downloads', downloads);
  net.servers.length = 0;
  net.clients.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('the controller, facing a host it dialed', () => {
  function victimFolder() {
    const dir = tempDir('runova-lan-victim-');
    writeFileSync(join(dir, 'delete-me.txt'), 'keep me');
    writeFileSync(join(dir, 'secret.txt'), 'DUMMY-SECRET');
    mkdirSync(join(dir, 'Startup'));
    return dir;
  }

  /** The manager dials, and the test answers as a host holding `hostIdentity`. */
  function dialTo(pinned: string, hostIdentity = newIdentity()) {
    const manager = new RemoteManager();
    manager.connect({
      ip: '192.0.2.10',
      port: 7900,
      token: 'pairing-code-token',
      deviceName: 'Host',
      hostKey: pinned,
    });
    const client = net.clients.at(-1) as Wire;
    const hostWire = new ws.FakeWire();
    joined(client, hostWire);
    const link = linkOn(hostWire);
    const handshake = link.runAsHost({
      sessionId: LAN_SESSION_ID,
      mode: 'ask',
      identity: hostIdentity,
      expectedControllerKey: null,
    });
    client.emit('open');
    return { manager, client, hostWire, link, handshake };
  }

  async function dial() {
    const identity = newIdentity();
    const { manager, client, hostWire, link, handshake } = dialTo(
      b64u(identity.publicKey),
      identity,
    );
    await handshake;
    const host = new End(hostWire, link);
    await vi.waitFor(() => expect(host.last('auth')).toBeDefined());
    return { manager, client, host };
  }

  it('signs in only inside the link, after the host proved the key from the pairing code', async () => {
    const { client, host } = await dial();

    expect(host.last('hello')).toMatchObject({ role: 'controller' });
    expect(host.last('auth')).toEqual({ t: 'auth', token: 'pairing-code-token' });
    expect(wireText(client, host.wire)).not.toContain('pairing-code-token');
  });

  it('never sends its token to a host that can not prove the pinned key', async () => {
    const pinned = b64u(newIdentity().publicKey);
    const { manager, client, hostWire, handshake } = dialTo(pinned, newIdentity());
    await handshake.catch(() => undefined);

    await vi.waitFor(() => expect(manager.getState().connection.status).toBe('error'));
    expect(manager.getState().connection.error).toContain('not the one you paired with');
    expect(wireText(client, hostWire)).not.toContain('pairing-code-token');
    expect(client.readyState).toBe(3);
  });

  it('will not reconnect to a saved server that has no host key to check', async () => {
    const dataDir = join(userData, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'remote-servers.json'),
      JSON.stringify([
        {
          id: 'old',
          nickname: 'Desk',
          ip: '192.0.2.10',
          port: 7900,
          deviceName: 'Desk',
          deviceToken: 'saved-token',
          createdAt: 1,
          lastConnectedAt: 1,
        },
      ]),
    );
    const manager = new RemoteManager();

    const result = await manager.connectSaved('old');

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Pair') });
    expect(net.clients).toEqual([]);
  });

  async function attack(host: End, dir: string, n: number): Promise<void> {
    host.send({ t: 'fm-delete', reqId: `del-${n}`, path: join(dir, 'delete-me.txt') });
    host.send({ t: 'fm-rename', reqId: `ren-${n}`, path: join(dir, 'secret.txt'), newName: 'x' });
    host.send({ t: 'fm-mkdir', reqId: `mk-${n}`, parentPath: dir, name: 'planted' });
    host.send({ t: 'fm-list', reqId: `ls-${n}`, path: dir });
    host.send({ t: 'fm-roots', reqId: `roots-${n}` });
    host.send({ t: 'file-request', reqId: `get-${n}`, path: join(dir, 'secret.txt') });
    await settle();
  }

  function expectUntouched(host: End, dir: string, n: number): void {
    expect(readFileSync(join(dir, 'delete-me.txt'), 'utf-8')).toBe('keep me');
    expect(readFileSync(join(dir, 'secret.txt'), 'utf-8')).toBe('DUMMY-SECRET');
    expect(existsSync(join(dir, 'planted'))).toBe(false);
    for (const id of [`del-${n}`, `ren-${n}`, `mk-${n}`]) {
      expect(host.controls('fm-ack').find((m) => m.reqId === id)).toMatchObject({ ok: false });
    }
    expect(host.last('fm-list-reply')).toMatchObject({ reqId: `ls-${n}`, entries: [] });
    expect(host.last('fm-roots-reply')).toMatchObject({ reqId: `roots-${n}`, roots: [] });
    expect(host.last('file-request-ack')).toMatchObject({ reqId: `get-${n}`, ok: false });
    // Nothing from this disk went out.
    expect(host.controls('file-offer')).toEqual([]);
    expect(host.received.some((m) => m instanceof Uint8Array)).toBe(false);
  }

  it('refuses file requests from the host before it is let in', async () => {
    const dir = victimFolder();
    const { manager, host } = await dial();

    await attack(host, dir, 1);

    expect(manager.getState().connection.status).toBe('connecting');
    expectUntouched(host, dir, 1);
  });

  it('refuses them after auth-ok too', async () => {
    const dir = victimFolder();
    const { manager, host } = await dial();
    host.send({ t: 'auth-ok', deviceName: 'Host', screen: { width: 0, height: 0 } });
    await vi.waitFor(() => expect(manager.getState().connection.status).toBe('connected'));

    await attack(host, dir, 2);

    expectUntouched(host, dir, 2);
  });

  it('ignores a file offer and clipboard text before auth-ok', async () => {
    const dir = victimFolder();
    const { host } = await dial();

    host.send({
      t: 'file-offer',
      transferId: 'evil-1',
      name: 'evil.cmd',
      size: 4,
      partSize: 4,
      partCount: 1,
      destDir: join(dir, 'Startup'),
    });
    host.send({ t: 'clipboard', text: 'pasted by the host' });
    await settle();

    expect(host.controls('file-resume')).toEqual([]);
    expect(readdirSync(join(dir, 'Startup'))).toEqual([]);
    expect(electronState.clipboardText).not.toBe('pasted by the host');
  });

  it('saves a file the host sends into Downloads, whatever folder the host names', async () => {
    const dir = victimFolder();
    const { manager, host } = await dial();
    host.send({ t: 'auth-ok', deviceName: 'Host', screen: { width: 0, height: 0 } });
    await vi.waitFor(() => expect(manager.getState().connection.status).toBe('connected'));

    const bytes = Buffer.from('echo');
    const transferId = 'evil-2';
    host.send({
      t: 'file-offer',
      transferId,
      name: 'evil.cmd',
      size: bytes.byteLength,
      partSize: bytes.byteLength,
      partCount: 1,
      destDir: join(dir, 'Startup'),
    });
    await vi.waitFor(() => expect(host.last('file-resume')).toBeDefined());
    host.sendBinary(
      encodeFileChunk({
        transferKey: transferKeyFromId(transferId),
        partIndex: 0,
        seq: 0,
        bytes,
      }),
    );
    const hash = createHash('sha256').update(bytes).digest('hex');
    host.send({ t: 'file-part-done', transferId, partIndex: 0, hash, size: bytes.byteLength });
    host.send({ t: 'file-complete', transferId, hash });
    await vi.waitFor(() => expect(host.last('file-done')).toMatchObject({ verified: true }));

    expect(readdirSync(join(dir, 'Startup'))).toEqual([]);
    expect(readFileSync(join(downloads, 'evil.cmd'), 'utf-8')).toBe('echo');
  });
});

describe('paired LAN devices on the host', () => {
  function host() {
    const manager = new RemoteManager();
    manager.startHost('192.0.2.10', 7900);
    const server = net.servers.at(-1);
    if (!server) throw new Error('no server');

    /** A fresh connection to the host, as its server sees it, and the test's own end of it. */
    function open(address: string): { hostSide: Wire; mine: Wire } {
      const hostSide = new ws.FakeWire();
      const mine = new ws.FakeWire();
      joined(hostSide, mine);
      server?.emit('connection', hostSide, { socket: { remoteAddress: address } });
      return { hostSide, mine };
    }

    async function connect(
      name: string,
      token: string,
      hostKey: string,
      address = '192.0.2.30',
    ): Promise<End> {
      const { mine } = open(address);
      const link = linkOn(mine);
      await link.runAsController({
        sessionId: LAN_SESSION_ID,
        mode: 'ask',
        identity: newIdentity(),
        expectedHostKey: fromB64u(hostKey),
      });
      const end = new End(mine, link);
      end.send({
        t: 'hello',
        role: 'controller',
        deviceName: name,
        protocolVersion: 4,
        intent: 'control',
      });
      end.send({ t: 'auth', token });
      await vi.waitFor(() => expect(end.last('auth-ok') ?? end.last('auth-fail')).toBeDefined());
      return end;
    }

    async function code() {
      const decoded = decodePairingCode((await manager.generatePairingCode()).code);
      if (!decoded) throw new Error('no pairing code');
      return decoded;
    }

    async function pair(name: string) {
      const { token, hostKey } = await code();
      const end = await connect(name, token, hostKey);
      const deviceToken = end.last('auth-ok')?.deviceToken;
      if (typeof deviceToken !== 'string') throw new Error('no device token');
      return { end, deviceToken, pairingToken: token, hostKey };
    }
    return { manager, open, connect, code, pair };
  }

  it('puts its own key in the pairing code and keeps it across restarts', async () => {
    const first = await host().code();
    const second = await host().code();

    expect(fromB64u(first.hostKey)).toHaveLength(32);
    expect(second.hostKey).toBe(first.hostKey);
    const file = readFileSync(join(userData, 'remote-host-key.json'), 'utf-8');
    expect(file).not.toContain(first.hostKey);
  });

  it('never lets a pairing code or a device token cross the wire readable', async () => {
    const { connect, pair } = host();
    const { end, deviceToken, pairingToken, hostKey } = await pair('Phone');
    const again = await connect('Phone', deviceToken, hostKey);

    expect(again.last('auth-ok')).toBeDefined();
    const seen = wireText(end.wire, end.wire.peer as Wire, again.wire, again.wire.peer as Wire);
    expect(seen).not.toContain(pairingToken);
    expect(seen).not.toContain(deviceToken);
  });

  it('reads nothing from a controller that skips the secure handshake', async () => {
    const { manager, open, code, connect } = host();
    const { token, hostKey } = await code();
    const { hostSide, mine } = open('198.51.100.99');

    mine.send(
      JSON.stringify({ t: 'hello', role: 'controller', deviceName: 'Old', intent: 'control' }),
    );
    mine.send(JSON.stringify({ t: 'auth', token }));
    await settle();

    expect(manager.getState().peers).toEqual([]);
    expect(hostSide.out).toEqual([]);
    // The code was never read, so the device it was meant for can still pair with it.
    const real = await connect('Phone', token, hostKey);
    expect(real.last('auth-ok')).toBeDefined();
  });

  it('shrugs off malformed frames from a peer that never signed in', async () => {
    const { code, open } = host();
    const { token, hostKey } = await code();
    // Anyone on the network can finish the handshake: the host has no key for them to prove.
    async function stranger(): Promise<End> {
      const { mine } = open('198.51.100.7');
      const link = linkOn(mine);
      await link.runAsController({
        sessionId: LAN_SESSION_ID,
        mode: 'ask',
        identity: newIdentity(),
        expectedHostKey: fromB64u(hostKey),
      });
      return new End(mine, link);
    }

    // A file chunk too short to hold its header, before any sign-in. The link stays up, so the
    // same connection can still pair.
    const first = await stranger();
    first.sendBinary(new Uint8Array([2]));
    first.sendBinary(new Uint8Array([2, 0, 0, 0]));
    await settle();
    first.send({ t: 'hello', role: 'controller', deviceName: 'Phone', protocolVersion: 4 });
    first.send({ t: 'auth', token });
    await vi.waitFor(() => expect(first.last('auth-ok')).toBeDefined());

    // A token that is not text gets an answer, not an exception, while a code waits to be used.
    await code();
    for (const bad of [12345, { length: 3 }, null]) {
      const end = await stranger();
      end.send({ t: 'auth', token: bad });
      await vi.waitFor(() => expect(end.last('auth-fail')).toBeDefined());
    }
  });

  it('lists a device that paired, under the name it paired with', async () => {
    const { manager, connect, pair } = host();
    const { deviceToken, hostKey } = await pair('Phone');

    const again = await connect('AttackerBox', deviceToken, hostKey, '198.51.100.99');

    expect(again.last('auth-ok')).toBeDefined();
    expect(manager.listPairedDevices()).toEqual([
      expect.objectContaining({ deviceName: 'Phone', id: expect.any(String) }),
    ]);
    expect(manager.getState().peers.map((p) => p.deviceName)).toEqual(['Phone', 'Phone']);
    // The list handed to the screen carries no secret.
    expect(JSON.stringify(manager.listPairedDevices())).not.toContain(deviceToken);
  });

  it('ends a revoked device session and turns its token away afterwards', async () => {
    const { manager, connect, pair } = host();
    const { end, deviceToken, hostKey } = await pair('Phone');
    const [device] = manager.listPairedDevices();

    manager.revokePairedDevice(device.id);

    await vi.waitFor(() => expect(end.wire.readyState).toBe(3));
    expect(manager.getState().peers).toEqual([]);
    expect(manager.listPairedDevices()).toEqual([]);
    const retry = await connect('Phone', deviceToken, hostKey);
    expect(retry.last('auth-fail')).toBeDefined();
    expect(retry.last('auth-ok')).toBeUndefined();
  });

  it('turns away a token that went unused for more than 30 days', async () => {
    const { connect, pair } = host();
    const { end, deviceToken, hostKey } = await pair('Phone');
    end.link.close();

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const retry = await connect('Phone', deviceToken, hostKey);

    expect(retry.last('auth-fail')).toBeDefined();
    expect(retry.last('auth-ok')).toBeUndefined();
  });
});
