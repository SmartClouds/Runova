/**
 * The WebRTC side of a Runova Anywhere direct link (E61). Main has no WebRTC, so the main window
 * holds one RTCPeerConnection per session with a single ordered, reliable data channel, and
 * passes link frames to and from main untouched. The controller makes the offer; the signaling
 * goes through main to the website's hub.
 *
 * Screen video does not go here: once the link is secured, the usual remote-control flow
 * negotiates its own video connection over the link, as on a LAN.
 */

type Signal =
  | { k: 'sdp'; type: 'offer' | 'answer'; sdp: string }
  | { k: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

interface Session {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
  opened: boolean;
  closed: boolean;
  bufferedTimer: ReturnType<typeof setInterval> | null;
}

const BUFFERED_EVERY_MS = 200;

/** The DTLS fingerprint in an SDP, written the same way on both sides: `sha-256 AB:CD:...`. */
export function fingerprintOf(sdp: string | undefined): string {
  const match = /a=fingerprint:(\S+) (\S+)/i.exec(sdp ?? '');
  return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : '';
}

export function initAnywhereLinks(
  options: { createPeer?: (config: RTCConfiguration) => RTCPeerConnection } = {},
): () => void {
  const createPeer =
    options.createPeer ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));
  const sessions = new Map<string, Session>();
  const api = window.runova.anywhere;

  function signal(sessionId: string, message: Signal): void {
    api.linkSignal(sessionId, JSON.stringify(message));
  }

  function closed(sessionId: string, session: Session, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    if (session.bufferedTimer) clearInterval(session.bufferedTimer);
    sessions.delete(sessionId);
    try {
      session.pc.close();
    } catch {
      // Already closed.
    }
    api.linkClosed(sessionId, reason);
  }

  function wire(sessionId: string, session: Session, channel: RTCDataChannel): void {
    session.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      session.opened = true;
      api.linkOpened(sessionId, {
        local: fingerprintOf(session.pc.localDescription?.sdp),
        remote: fingerprintOf(session.pc.remoteDescription?.sdp),
      });
      session.bufferedTimer = setInterval(
        () => api.linkBuffered(sessionId, channel.bufferedAmount),
        BUFFERED_EVERY_MS,
      );
    };
    channel.onmessage = (event) => {
      const data = event.data as ArrayBuffer | Uint8Array;
      api.linkFrame(sessionId, data instanceof Uint8Array ? data : new Uint8Array(data));
    };
    channel.onclose = () => closed(sessionId, session, 'the data channel closed');
  }

  async function start(input: {
    sessionId: string;
    role: 'controller' | 'host';
    iceServers: { urls: string }[];
  }): Promise<void> {
    const pc = createPeer({ iceServers: input.iceServers });
    const session: Session = {
      pc,
      channel: null,
      remoteSet: false,
      pendingIce: [],
      opened: false,
      closed: false,
      bufferedTimer: null,
    };
    sessions.set(input.sessionId, session);
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      signal(input.sessionId, {
        k: 'ice',
        candidate: candidate.candidate ?? '',
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed')
        closed(input.sessionId, session, 'the connection failed');
    };
    if (input.role === 'controller') {
      wire(input.sessionId, session, pc.createDataChannel('runova-link', { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signal(input.sessionId, { k: 'sdp', type: 'offer', sdp: offer.sdp ?? '' });
    } else {
      pc.ondatachannel = (event) => wire(input.sessionId, session, event.channel);
    }
  }

  async function onSignal(sessionId: string, payload: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    let message: Signal;
    try {
      message = JSON.parse(payload) as Signal;
    } catch {
      return;
    }
    if (message.k === 'ice') {
      const candidate = {
        candidate: message.candidate,
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex,
      };
      if (session.remoteSet) await session.pc.addIceCandidate(candidate).catch(() => undefined);
      else session.pendingIce.push(candidate);
      return;
    }
    await session.pc.setRemoteDescription({ type: message.type, sdp: message.sdp });
    session.remoteSet = true;
    for (const candidate of session.pendingIce.splice(0))
      await session.pc.addIceCandidate(candidate).catch(() => undefined);
    if (message.type === 'offer') {
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      signal(sessionId, { k: 'sdp', type: 'answer', sdp: answer.sdp ?? '' });
    }
  }

  const unsubscribe = [
    api.onLinkStart((input) => {
      void start(input).catch(() => {
        const session = sessions.get(input.sessionId);
        if (session) closed(input.sessionId, session, 'the connection could not start');
      });
    }),
    api.onLinkSignal(({ sessionId, payload }) => {
      void onSignal(sessionId, payload).catch(() => {
        const session = sessions.get(sessionId);
        if (session) closed(sessionId, session, 'the connection could not be negotiated');
      });
    }),
    api.onLinkFrame(({ sessionId, frame }) => {
      const channel = sessions.get(sessionId)?.channel;
      // IPC hands over a plain Uint8Array; the channel wants one backed by an ArrayBuffer.
      if (channel?.readyState === 'open') channel.send(frame as Uint8Array<ArrayBuffer>);
    }),
    api.onLinkStop(({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.closed = true;
      if (session.bufferedTimer) clearInterval(session.bufferedTimer);
      sessions.delete(sessionId);
      session.pc.close();
    }),
  ];

  return () => {
    for (const off of unsubscribe) off();
    for (const session of sessions.values()) {
      if (session.bufferedTimer) clearInterval(session.bufferedTimer);
      session.pc.close();
    }
    sessions.clear();
  };
}
