import { SOCKET_CLOSED, SOCKET_OPEN } from '../../main/remote/peerSocket';
import type { SendLink } from '../../main/remote/send/batch';

/** One end of an in-memory link, with what a test needs to break it on purpose. */
export interface MemoryLink extends SendLink {
  /** Every message this end sent, decoded: text as parsed JSON, binary as its length. */
  readonly sent: ({ t: string } & Record<string, unknown>)[];
  /** The other end stops hearing this one, as a dead network does, without either side closing. */
  silence(): void;
  /** Both ends close, as when the network goes for good. */
  drop(reason?: string): void;
}

/**
 * Two connected ends that pass messages in order, each on a microtask, the way a link delivers
 * them after the handshake. Binary messages arrive as Buffers.
 */
export function memoryLinkPair(): [MemoryLink, MemoryLink] {
  const ends: MemoryLink[] = [];
  function end(index: number): MemoryLink {
    const messageListeners: ((data: Buffer, isBinary: boolean) => void)[] = [];
    const closeListeners: ((reason: string) => void)[] = [];
    const unheard: { data: Buffer; isBinary: boolean }[] = [];
    let open = true;
    let silenced = false;
    const self: MemoryLink & {
      hear(data: Buffer, isBinary: boolean): void;
      shut(reason: string): void;
    } = {
      sent: [],
      get readyState() {
        return open ? SOCKET_OPEN : SOCKET_CLOSED;
      },
      bufferedAmount: 0,
      send(data, options, cb) {
        if (!open) {
          cb?.(new Error('The link is not open.'));
          return;
        }
        const isBinary = typeof data !== 'string' && options?.binary !== false;
        const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
        self.sent.push(
          isBinary ? { t: 'binary', length: bytes.length } : JSON.parse(bytes.toString()),
        );
        const other = ends[1 - index] as typeof self;
        if (!silenced) queueMicrotask(() => other.hear(bytes, isBinary));
        cb?.();
      },
      close() {
        if (!open) return;
        const other = ends[1 - index] as typeof self;
        self.shut('closed');
        queueMicrotask(() => other.shut('closed'));
      },
      onMessage(listener) {
        messageListeners.push(listener);
        for (const message of unheard.splice(0)) listener(message.data, message.isBinary);
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
      drain: () => Promise.resolve(),
      silence() {
        silenced = true;
      },
      drop(reason = 'the network went away') {
        const other = ends[1 - index] as typeof self;
        self.shut(reason);
        other.shut(reason);
      },
      hear(data, isBinary) {
        if (!open) return;
        if (messageListeners.length === 0) unheard.push({ data, isBinary });
        for (const listener of messageListeners) listener(data, isBinary);
      },
      shut(reason) {
        if (!open) return;
        open = false;
        for (const listener of closeListeners) listener(reason);
      },
    };
    return self;
  }
  ends.push(end(0), end(1));
  return [ends[0], ends[1]];
}
