/**
 * What the remote-control code needs from a connection to another Runova: the part of a `ws`
 * WebSocket it uses. A LAN connection is a real WebSocket; a Runova Anywhere connection is a
 * {@link import('./anywhere/link').SecureLink} over WebRTC or the relay, which looks the same from here.
 */
export interface PeerSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, options?: { binary?: boolean }, cb?: (err?: Error) => void): void;
  close(): void;
}

/** The `readyState` values, as a WebSocket has them. */
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSING = 2;
export const SOCKET_CLOSED = 3;
