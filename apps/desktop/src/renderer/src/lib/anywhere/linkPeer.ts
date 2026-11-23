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
  role: 'controller' | 'host';
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  remoteSet: boolean;
  pendingIce: RTCIceCandidateInit[];
  opened: boolean;
  /** Frames that arrived before main heard the link is open, sent on once it has. */
  early: Uint8Array[] | null;
  closed: boolean;
  bufferedTimer: ReturnType<typeof setInterval> | null;
}

const BUFFERED_EVERY_MS = 200;

/**
 * The DTLS fingerprint in an SDP, written the same way on both sides: `sha-256 AB:CD:...`.
 * Sections that name different fingerprints leave open which one DTLS checks, so then none is.
 */
export function fingerprintOf(sdp: string | undefined): string {
  const all = new Set(
    [...(sdp ?? '').matchAll(/^a=fingerprint:(\S+) (\S+)\s*$/gim)].map(
      (match) => `${match[1].toLowerCase()} ${match[2].toUpperCase()}`,
    ),
  );
  return all.size === 1 ? [...all][0] : '';
}

const DIGESTS: Record<string, string> = {
  'sha-1': 'SHA-1',
  'sha-256': 'SHA-256',
  'sha-384': 'SHA-384',
  'sha-512': 'SHA-512',
};

/**
 * The fingerprint of the certificate DTLS actually checked, which is what the handshake binds.
 * The remote SDP comes through the website's hub, so a line in it proves nothing on its own: it is
 * only the fallback for a browser that can not show the transport's certificate.
 */
async function verifiedRemoteFingerprint(pc: RTCPeerConnection): Promise<string> {
  const announced = fingerprintOf(pc.remoteDescription?.sdp);
  const certificates = pc.sctp?.transport?.getRemoteCertificates?.() ?? [];
  if (certificates.length === 0) return announced;
  const named = announced.split(' ')[0];
  const algorithm = named && DIGESTS[named] ? named : 'sha-256';
  const digest = new Uint8Array(await crypto.subtle.digest(DIGESTS[algorithm], certificates[0]));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase());
  return `${algorithm} ${hex.join(':')}`;
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
      session.early = [];
      void verifiedRemoteFingerprint(session.pc).then(
        (remote) => {
          if (session.closed) return;
          api.linkOpened(sessionId, {
            local: fingerprintOf(session.pc.localDescription?.sdp),
            remote,
          });
          for (const frame of session.early ?? []) api.linkFrame(sessionId, frame);
          session.early = null;
          session.bufferedTimer = setInterval(
            () => api.linkBuffered(sessionId, channel.bufferedAmount),
            BUFFERED_EVERY_MS,
          );
        },
        () => closed(sessionId, session, 'the DTLS certificate could not be read'),
      );
    };
    channel.onmessage = (event) => {
      const data = event.data as ArrayBuffer | Uint8Array;
      const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (session.early) session.early.push(frame);
      else api.linkFrame(sessionId, frame);
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
      role: input.role,
      pc,
      channel: null,
      remoteSet: false,
      pendingIce: [],
      opened: false,
      early: null,
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
    // The controller makes the one offer and the host answers it. A description of the other kind,
    // or a second one, can only come from a hub trying to sit in the middle of the DTLS link.
    const expected = session.role === 'controller' ? 'answer' : 'offer';
    if (message.type !== expected || session.remoteSet) {
      closed(sessionId, session, `the other side sent an unexpected ${message.type}`);
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
      const session = sessions.get(sessionId);
      const channel = session?.channel;
      if (!session || channel?.readyState !== 'open') return;
      try {
        // IPC hands over a plain Uint8Array; the channel wants one backed by an ArrayBuffer.
        channel.send(frame as Uint8Array<ArrayBuffer>);
      } catch (error) {
        // A channel past its send limit throws; a link that lost a frame can not go on.
        closed(
          sessionId,
          session,
          `the channel could not send: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
