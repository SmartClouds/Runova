import {
  type ControllerOptions,
  controllerHandshake,
  encodeLinkMessage,
  HandshakeError,
  type HandshakeMessage,
  type HostOptions,
  hostHandshake,
  LINK_BINARY,
  LINK_TEXT,
  LinkReassembler,
  type SessionKeys,
} from '@runova/protocol';
import { type PeerSocket, SOCKET_CLOSED, SOCKET_CONNECTING, SOCKET_OPEN } from '../peerSocket';

/** One way to carry link frames between two computers: a WebRTC data channel, or the relay. */
export interface LinkTransport {
  send(frame: Uint8Array): void;
  bufferedAmount(): number;
  close(reason: string): void;
  onFrame(listener: (frame: Uint8Array) => void): void;
  onClose(listener: (reason: string) => void): void;
}

/** Seals each frame after the handshake, for a transport that is not encrypted end to end itself (the relay). */
export interface FrameCipher {
  seal(frame: Uint8Array): Uint8Array;
  open(frame: Uint8Array): Uint8Array;
}

export interface SecureLinkOptions {
  handshakeTimeoutMs?: number;
  cipher?: (keys: SessionKeys) => FrameCipher;
}

type Waiter = {
  expect: HandshakeMessage['t'];
  resolve: (message: HandshakeMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * A Runova Anywhere connection (E61): the secure handshake first, then the usual remote-control
 * messages, over whichever transport found the other computer. Until the handshake succeeds
 * nothing but handshake messages is accepted, so an unauthenticated peer can not send a single
 * input event. Once open it behaves like the WebSocket {@link PeerSocket} the remote-control
 * code already speaks.
 */
export class SecureLink implements PeerSocket {
  private state: 'handshake' | 'open' | 'closed' = 'handshake';
  private readonly reassembler = new LinkReassembler();
  private nextMessageId = 1;
  private waiter: Waiter | null = null;
  /** Handshake messages that came before anyone waited for them. */
  private readonly handshakeInbox: HandshakeMessage[] = [];
  /** Frames that came right after the last handshake message, before this side opened. */
  private readonly early: Uint8Array[] = [];
  private finalReceived = false;
  private cipher: FrameCipher | null = null;
  private readonly messageListeners: ((data: Buffer, isBinary: boolean) => void)[] = [];
  private readonly closeListeners: ((reason: string) => void)[] = [];
  private readonly unheard: { data: Buffer; isBinary: boolean }[] = [];
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: LinkTransport,
    private readonly options: SecureLinkOptions = {},
  ) {
    this.timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    transport.onFrame((frame) => this.onFrame(frame));
    transport.onClose((reason) => this.closed(reason));
  }

  get readyState(): number {
    if (this.state === 'open') return SOCKET_OPEN;
    return this.state === 'closed' ? SOCKET_CLOSED : SOCKET_CONNECTING;
  }

  get bufferedAmount(): number {
    return this.transport.bufferedAmount();
  }

  async runAsController(options: ControllerOptions): Promise<SessionKeys> {
    const handshake = controllerHandshake(options);
    this.sendHandshake(handshake.hello);
    const reply = await this.next('hs-reply');
    try {
      const { finish, keys } = handshake.complete(
        reply as Parameters<typeof handshake.complete>[0],
      );
      this.sendHandshake(finish);
      this.open(keys);
      return keys;
    } catch (error) {
      throw this.abort(error);
    }
  }

  async runAsHost(options: HostOptions): Promise<SessionKeys> {
    const handshake = hostHandshake(options);
    const hello = await this.next('hs-hello');
    try {
      this.sendHandshake(handshake.respond(hello as Parameters<typeof handshake.respond>[0]));
    } catch (error) {
      throw this.abort(error);
    }
    const finish = await this.next('hs-finish');
    try {
      const keys = handshake.complete(finish as Parameters<typeof handshake.complete>[0]);
      this.open(keys);
      return keys;
    } catch (error) {
      throw this.abort(error);
    }
  }

  send(
    data: string | Uint8Array,
    options?: { binary?: boolean },
    cb?: (err?: Error) => void,
  ): void {
    if (this.state !== 'open') {
      cb?.(new Error('The link is not open.'));
      return;
    }
    const text = typeof data === 'string' || options?.binary === false;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    try {
      for (const frame of encodeLinkMessage(
        text ? LINK_TEXT : LINK_BINARY,
        payload,
        this.nextMessageId++,
      )) {
        this.transport.send(this.cipher ? this.cipher.seal(frame) : frame);
      }
      cb?.();
    } catch (error) {
      cb?.(error as Error);
    }
  }

  close(): void {
    if (this.state === 'closed') return;
    this.transport.close('closed');
    this.closed('closed');
  }

  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void {
    this.messageListeners.push(listener);
    for (const message of this.unheard.splice(0)) listener(message.data, message.isBinary);
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener);
  }

  // --- Internals -----------------------------------------------------------------

  private onFrame(frame: Uint8Array): void {
    if (this.state === 'closed') return;
    if (this.state === 'open') {
      this.deliver(frame);
      return;
    }
    if (this.finalReceived) {
      this.early.push(frame);
      return;
    }
    const message = parseHandshake(frame);
    if (!message) {
      this.fail(
        new HandshakeError(
          'protocol',
          'The other computer sent something before the secure handshake.',
        ),
      );
      return;
    }
    if (message.t === 'hs-finish') this.finalReceived = true;
    if (this.waiter) this.settle(message);
    else this.handshakeInbox.push(message);
  }

  private next(expect: HandshakeMessage['t']): Promise<HandshakeMessage> {
    return new Promise((resolve, reject) => {
      if (this.state === 'closed') {
        reject(new Error('The link closed during the secure handshake.'));
        return;
      }
      const timer = setTimeout(
        () => this.fail(new Error('The other computer did not answer the secure handshake.')),
        this.timeoutMs,
      );
      this.waiter = { expect, resolve, reject, timer };
      const queued = this.handshakeInbox.shift();
      if (queued) this.settle(queued);
    });
  }

  private settle(message: HandshakeMessage): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    clearTimeout(waiter.timer);
    if (message.t === 'hs-abort') {
      const reason = message.reason;
      const error = new HandshakeError(
        ['protocol', 'identity', 'fingerprint', 'signature', 'wrong-password'].includes(reason)
          ? reason
          : 'protocol',
      );
      waiter.reject(error);
      this.close();
    } else if (message.t !== waiter.expect) {
      waiter.reject(new HandshakeError('protocol'));
      this.close();
    } else {
      waiter.resolve(message);
    }
  }

  private open(keys: SessionKeys): void {
    this.cipher = this.options.cipher ? this.options.cipher(keys) : null;
    this.state = 'open';
    for (const frame of this.early.splice(0)) this.deliver(frame);
  }

  private deliver(frame: Uint8Array): void {
    let message: ReturnType<LinkReassembler['push']>;
    try {
      message = this.reassembler.push(this.cipher ? this.cipher.open(frame) : frame);
    } catch {
      this.close();
      return;
    }
    if (!message) return;
    const data = Buffer.from(
      message.payload.buffer,
      message.payload.byteOffset,
      message.payload.byteLength,
    );
    const isBinary = message.kind === LINK_BINARY;
    if (this.messageListeners.length === 0) {
      this.unheard.push({ data, isBinary });
      return;
    }
    for (const listener of this.messageListeners) listener(data, isBinary);
  }

  private sendHandshake(message: HandshakeMessage): void {
    for (const frame of encodeLinkMessage(
      LINK_TEXT,
      Buffer.from(JSON.stringify(message), 'utf-8'),
      this.nextMessageId++,
    )) {
      this.transport.send(frame);
    }
  }

  /** Tells the other side why, closes, and gives back the error to throw. */
  private abort(error: unknown): Error {
    if (error instanceof HandshakeError && this.state !== 'closed') {
      try {
        this.sendHandshake({ t: 'hs-abort', reason: error.reason });
      } catch {
        // The transport is gone already.
      }
    }
    this.close();
    return error instanceof Error ? error : new Error(String(error));
  }

  private fail(error: Error): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.close();
  }

  private closed(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('The link closed during the secure handshake.'));
    }
    for (const listener of this.closeListeners) listener(reason);
  }
}

function parseHandshake(frame: Uint8Array): HandshakeMessage | null {
  if (frame[0] !== LINK_TEXT) return null;
  try {
    const message = JSON.parse(Buffer.from(frame.subarray(1)).toString('utf-8')) as { t?: unknown };
    return typeof message?.t === 'string' && message.t.startsWith('hs-')
      ? (message as HandshakeMessage)
      : null;
  } catch {
    return null;
  }
}
