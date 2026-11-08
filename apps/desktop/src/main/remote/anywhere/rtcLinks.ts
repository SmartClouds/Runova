import type { LinkTransport } from './link';
import type { LinkOpener, OpenedLink } from './links';

/**
 * Public STUN only: enough to find a direct way through most home and office routers. No TURN
 * server is configured, so a direct link never sends media through a third party; when there is
 * no direct way, the website's relay takes over (E62), still encrypted end to end.
 */
export const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** How long a direct connection gets before the relay takes over. */
export const DIRECT_TIMEOUT_MS = 8_000;

/** How main talks to the WebRTC peer in the renderer, which owns the data channel. */
export interface RtcLinkBridge {
  startPeer(input: {
    sessionId: string;
    role: 'controller' | 'host';
    iceServers: typeof STUN_SERVERS;
  }): void;
  deliverSignal(sessionId: string, payload: string): void;
  sendFrame(sessionId: string, frame: Uint8Array): void;
  stopPeer(sessionId: string, reason: string): void;
}

/** Opens a relay link for a session (E62). */
export type RelayOpener = (input: {
  sessionId: string;
  role: 'controller' | 'host';
}) => Promise<OpenedLink>;

interface Session {
  role: 'controller' | 'host';
  signal: (payload: string) => void;
  started: boolean;
  settled: boolean;
  resolve: (link: OpenedLink) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  buffered: number;
  frameListeners: ((frame: Uint8Array) => void)[];
  closeListeners: ((reason: string) => void)[];
  closed: boolean;
}

const RELAY_SIGNAL = '{"k":"relay"}';
const EARLY_SIGNALS_MAX = 64;

/**
 * Runova Anywhere's direct links (E61): a WebRTC data channel per session, made in the renderer
 * (Node has no WebRTC) and signaled through the website's hub. The controller makes the offer.
 * When the channel is not open in time, the controller tells the host and both switch to the
 * relay; either way the handshake above checks who is on the other end.
 */
export function createRtcLinkOpener(
  bridge: RtcLinkBridge,
  options: { directTimeoutMs?: number; relay?: RelayOpener } = {},
) {
  const directTimeoutMs = options.directTimeoutMs ?? DIRECT_TIMEOUT_MS;
  const sessions = new Map<string, Session>();
  /** Signals that came before this side opened the session, kept briefly. */
  const early = new Map<string, string[]>();

  function settle(sessionId: string, session: Session, outcome: OpenedLink | Error): void {
    if (session.settled) return;
    session.settled = true;
    if (session.timer) clearTimeout(session.timer);
    if (outcome instanceof Error) {
      sessions.delete(sessionId);
      session.reject(outcome);
    } else {
      session.resolve(outcome);
    }
  }

  function toRelay(sessionId: string, session: Session, tellOtherSide: boolean): void {
    if (session.settled) return;
    if (session.started) bridge.stopPeer(sessionId, 'falling back to the relay');
    session.started = false;
    sessions.delete(sessionId);
    if (!options.relay) {
      settle(
        sessionId,
        session,
        new Error('Could not reach the other computer directly, and the relay is not available.'),
      );
      return;
    }
    if (tellOtherSide) session.signal(RELAY_SIGNAL);
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    options.relay({ sessionId, role: session.role }).then(
      (link) => settle(sessionId, session, link),
      (error: unknown) =>
        settle(sessionId, session, error instanceof Error ? error : new Error(String(error))),
    );
  }

  function transportFor(sessionId: string, session: Session): LinkTransport {
    return {
      send: (frame) => {
        if (!session.closed) bridge.sendFrame(sessionId, frame);
      },
      bufferedAmount: () => session.buffered,
      close: (reason) => {
        if (session.closed) return;
        session.closed = true;
        sessions.delete(sessionId);
        bridge.stopPeer(sessionId, reason);
        for (const listener of session.closeListeners) listener(reason);
      },
      onFrame: (listener) => session.frameListeners.push(listener),
      onClose: (listener) => session.closeListeners.push(listener),
    };
  }

  const opener: LinkOpener = {
    open({ sessionId, role, relayOnly, signal }) {
      return new Promise<OpenedLink>((resolve, reject) => {
        const session: Session = {
          role,
          signal,
          started: false,
          settled: false,
          resolve,
          reject,
          timer: null,
          buffered: 0,
          frameListeners: [],
          closeListeners: [],
          closed: false,
        };
        sessions.set(sessionId, session);
        const waiting = early.get(sessionId) ?? [];
        early.delete(sessionId);
        if (relayOnly || waiting.includes(RELAY_SIGNAL)) {
          toRelay(sessionId, session, relayOnly);
          return;
        }
        session.started = true;
        bridge.startPeer({ sessionId, role, iceServers: STUN_SERVERS });
        for (const payload of waiting) bridge.deliverSignal(sessionId, payload);
        // The controller decides when to give up on a direct link; the host follows its word,
        // and only gives up alone if it hears nothing for twice as long.
        session.timer = setTimeout(
          () => toRelay(sessionId, session, true),
          role === 'controller' ? directTimeoutMs : directTimeoutMs * 2,
        );
      });
    },

    deliverSignal(sessionId, payload) {
      const session = sessions.get(sessionId);
      if (!session) {
        const queued = early.get(sessionId) ?? [];
        if (queued.length < EARLY_SIGNALS_MAX) queued.push(payload);
        early.set(sessionId, queued);
        setTimeout(() => early.delete(sessionId), 30_000).unref?.();
        return;
      }
      if (payload === RELAY_SIGNAL) {
        toRelay(sessionId, session, false);
        return;
      }
      if (session.started) bridge.deliverSignal(sessionId, payload);
    },

    cancel(sessionId) {
      early.delete(sessionId);
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      if (session.started) bridge.stopPeer(sessionId, 'cancelled');
      settle(sessionId, session, new Error('The connection was cancelled.'));
    },
  };

  return {
    ...opener,

    /** The renderer's peer produced a signaling message for the other side. */
    rendererSignal(sessionId: string, payload: string): void {
      sessions.get(sessionId)?.signal(payload);
    },

    /** The data channel is open; the fingerprints come from the two SDPs. */
    rendererOpened(sessionId: string, fingerprints: { local: string; remote: string }): void {
      const session = sessions.get(sessionId);
      if (!session || session.settled) return;
      settle(sessionId, session, {
        transport: transportFor(sessionId, session),
        kind: 'direct',
        localFingerprint: fingerprints.local,
        remoteFingerprint: fingerprints.remote,
      });
    },

    rendererFrame(sessionId: string, frame: Uint8Array): void {
      const session = sessions.get(sessionId);
      if (!session || session.closed) return;
      for (const listener of session.frameListeners) listener(frame);
    },

    rendererBuffered(sessionId: string, amount: number): void {
      const session = sessions.get(sessionId);
      if (session) session.buffered = amount;
    },

    /** The channel closed, or the peer failed before it opened. */
    rendererClosed(sessionId: string, reason: string): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      if (!session.settled) {
        // It never opened: let the controller move to the relay now rather than at the timeout.
        if (session.role === 'controller') toRelay(sessionId, session, true);
        return;
      }
      if (session.closed) return;
      session.closed = true;
      sessions.delete(sessionId);
      for (const listener of session.closeListeners) listener(reason);
    },
  };
}

export type RtcLinkOpener = ReturnType<typeof createRtcLinkOpener>;
