import type { WebSocket } from 'ws';
import { SecureLink } from './anywhere/link';
import { socketTransport } from './anywhere/relay';
import { createFrameCipher } from './anywhere/relayCipher';

/**
 * The LAN connection between a controller and a host. The socket itself is plain ws://, so it
 * runs the same secure handshake as Runova Anywhere and seals every frame after it with the
 * session keys. The controller checks the host against the key in the pairing code, and only then
 * sends a pairing code or device token, which never cross the network in the clear.
 */

/** Both ends put this in the handshake transcript. Each session's keys are fresh all the same. */
export const LAN_SESSION_ID = 'runova-lan-v1';

/** The largest frame either end takes: a link frame is 60 KiB plus the cipher's 24 bytes. */
export const LAN_MAX_FRAME = 128 * 1024;

export function lanLink(socket: WebSocket): SecureLink {
  return new SecureLink(socketTransport(socket, 'the connection closed'), {
    cipher: (keys) => createFrameCipher(keys),
  });
}
