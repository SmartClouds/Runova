import type { SessionKeys } from '@runova/protocol';
import type { AnywhereTransport } from '../../../shared/anywhere';
import type { FrameCipher, LinkTransport } from './link';

/** A link that reached the other computer, before the secure handshake. */
export interface OpenedLink {
  transport: LinkTransport;
  kind: AnywhereTransport;
  /** This side's DTLS fingerprint, or empty on the relay. */
  localFingerprint: string;
  /** The other side's DTLS fingerprint as received, or empty on the relay. */
  remoteFingerprint: string;
  /** Seals frames after the handshake, for a transport that is not end-to-end encrypted itself. */
  cipher?: (keys: SessionKeys) => FrameCipher;
}

/**
 * Finds a way to the other computer for a session: a direct WebRTC data channel first, and the
 * website's relay when that does not connect in time or the person asked for the relay only.
 */
export interface LinkOpener {
  open(input: {
    sessionId: string;
    role: 'controller' | 'host';
    relayOnly: boolean;
    /** Sends a signaling message to the other side through the hub. */
    signal: (payload: string) => void;
  }): Promise<OpenedLink>;
  /** A signaling message the other side sent for this session. */
  deliverSignal(sessionId: string, payload: string): void;
  /** Stops trying for this session. */
  cancel(sessionId: string): void;
}
