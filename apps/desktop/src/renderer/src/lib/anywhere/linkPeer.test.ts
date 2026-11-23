import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentBridge } from '../../../../test/renderer/runovaBridge';
import { fingerprintOf, initAnywhereLinks } from './linkPeer';

class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  binaryType = 'blob';
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(
    readonly label: string,
    readonly init?: RTCDataChannelInit,
  ) {}
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
}

class FakePeer {
  static all: FakePeer[] = [];
  channel: FakeChannel | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly candidates: unknown[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  closed = false;
  onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly config: RTCConfiguration) {
    FakePeer.all.push(this);
  }
  createDataChannel(label: string, init?: RTCDataChannelInit): FakeChannel {
    this.channel = new FakeChannel(label, init);
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 aa:bb:cc\r\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 11:22:33\r\n' };
  }
  async setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description;
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
  }
  close() {
    this.closed = true;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: () => void = () => undefined;
beforeEach(() => {
  FakePeer.all = [];
  stop = initAnywhereLinks({
    createPeer: (config) => new FakePeer(config) as unknown as RTCPeerConnection,
  });
});
afterEach(() => stop());

function signals(): { sessionId: string; payload: Record<string, unknown> }[] {
  return currentBridge()
    .$fn('anywhere.linkSignal')
    .mock.calls.map(([sessionId, payload]) => ({
      sessionId: sessionId as string,
      payload: JSON.parse(payload as string),
    }));
}

describe('the Anywhere WebRTC link peer', () => {
  it('makes an ordered data channel and an offer as the controller', async () => {
    currentBridge().$emit('anywhere.onLinkStart', {
      sessionId: 's1',
      role: 'controller',
      iceServers: [{ urls: 'stun:x' }],
    });
    await flush();

    const peer = FakePeer.all[0];
    expect(peer.config.iceServers).toEqual([{ urls: 'stun:x' }]);
    expect(peer.channel?.label).toBe('runova-link');
    expect(peer.channel?.init).toMatchObject({ ordered: true });
    expect(signals()).toEqual([
      { sessionId: 's1', payload: { k: 'sdp', type: 'offer', sdp: expect.any(String) } },
    ]);
  });

  it('answers an offer as the host, and adds ICE candidates only after the offer', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 's2', role: 'host', iceServers: [] });
    bridge.$emit('anywhere.onLinkSignal', {
      sessionId: 's2',
      payload: JSON.stringify({ k: 'ice', candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 }),
    });
    await flush();
    const peer = FakePeer.all[0];
    expect(peer.candidates).toEqual([]);

    bridge.$emit('anywhere.onLinkSignal', {
      sessionId: 's2',
      payload: JSON.stringify({
        k: 'sdp',
        type: 'offer',
        sdp: 'v=0\r\na=fingerprint:sha-256 aa:bb:cc\r\n',
      }),
    });
    await flush();
    await flush();

    expect(peer.remoteDescription?.type).toBe('offer');
    expect(peer.candidates).toEqual([{ candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 }]);
    expect(signals().at(-1)?.payload).toMatchObject({ k: 'sdp', type: 'answer' });
  });

  it('sends its ICE candidates to the other side', async () => {
    currentBridge().$emit('anywhere.onLinkStart', {
      sessionId: 's3',
      role: 'controller',
      iceServers: [],
    });
    await flush();

    FakePeer.all[0].onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 }) },
    });

    expect(signals().at(-1)).toEqual({
      sessionId: 's3',
      payload: { k: 'ice', candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 },
    });
  });

  it('says the link is open with both fingerprints, and carries frames both ways', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 's4', role: 'controller', iceServers: [] });
    await flush();
    const peer = FakePeer.all[0];
    bridge.$emit('anywhere.onLinkSignal', {
      sessionId: 's4',
      payload: JSON.stringify({
        k: 'sdp',
        type: 'answer',
        sdp: 'v=0\r\na=fingerprint:sha-256 11:22:33\r\n',
      }),
    });
    await flush();

    peer.channel?.open();
    // The other side may speak first; main gets that frame only after it hears the link is open.
    peer.channel?.onmessage?.({ data: new Uint8Array([5]).buffer });
    await flush();
    bridge.$emit('anywhere.onLinkFrame', { sessionId: 's4', frame: new Uint8Array([1, 2]) });
    peer.channel?.onmessage?.({ data: new Uint8Array([3, 4]).buffer });

    expect(bridge.$fn('anywhere.linkFrame')).toHaveBeenNthCalledWith(1, 's4', new Uint8Array([5]));
    expect(bridge.$fn('anywhere.linkFrame').mock.invocationCallOrder[0]).toBeGreaterThan(
      bridge.$fn('anywhere.linkOpened').mock.invocationCallOrder[0],
    );
    expect(bridge.$fn('anywhere.linkOpened')).toHaveBeenCalledWith('s4', {
      local: 'sha-256 AA:BB:CC',
      remote: 'sha-256 11:22:33',
    });
    expect(peer.channel?.binaryType).toBe('arraybuffer');
    expect(peer.channel?.sent).toEqual([new Uint8Array([1, 2])]);
    expect(bridge.$fn('anywhere.linkFrame')).toHaveBeenCalledWith('s4', new Uint8Array([3, 4]));
  });

  it('closes the peer when main stops the link, and tells main when the channel closes', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 's5', role: 'controller', iceServers: [] });
    await flush();
    const peer = FakePeer.all[0];
    peer.channel?.open();

    peer.channel?.close();
    expect(bridge.$fn('anywhere.linkClosed')).toHaveBeenCalledWith('s5', expect.any(String));

    bridge.$emit('anywhere.onLinkStop', { sessionId: 's5', reason: 'done' });
    expect(peer.closed).toBe(true);
  });

  it('closes the link when the data channel refuses a frame', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 's7', role: 'controller', iceServers: [] });
    await flush();
    const peer = FakePeer.all[0];
    peer.channel?.open();
    if (peer.channel) {
      peer.channel.send = () => {
        throw new Error('RTCDataChannel send queue is full');
      };
    }

    bridge.$emit('anywhere.onLinkFrame', { sessionId: 's7', frame: new Uint8Array([1]) });

    expect(bridge.$fn('anywhere.linkClosed')).toHaveBeenCalledWith(
      's7',
      expect.stringMatching(/full|could not send/i),
    );
    expect(peer.closed).toBe(true);
  });

  it('tells main when the connection fails before the channel opens', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 's6', role: 'controller', iceServers: [] });
    await flush();
    const peer = FakePeer.all[0];

    peer.connectionState = 'failed';
    peer.onconnectionstatechange?.();

    expect(bridge.$fn('anywhere.linkClosed')).toHaveBeenCalledWith(
      's6',
      expect.stringMatching(/failed/),
    );
    expect(peer.closed).toBe(true);
  });
});

describe('a hub that tampers with the signaling', () => {
  it('never answers an offer as the controller, which makes the offer itself', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 'c1', role: 'controller', iceServers: [] });
    await flush();
    const peer = FakePeer.all[0];

    bridge.$emit('anywhere.onLinkSignal', {
      sessionId: 'c1',
      payload: JSON.stringify({
        k: 'sdp',
        type: 'offer',
        sdp: 'v=0\r\na=fingerprint:sha-256 ee\r\n',
      }),
    });
    await flush();
    await flush();

    expect(peer.remoteDescription).toBeNull();
    expect(signals().filter((s) => s.payload.type === 'answer')).toEqual([]);
    expect(bridge.$fn('anywhere.linkClosed')).toHaveBeenCalledWith('c1', expect.any(String));
  });

  it('never takes an answer as the host, which only answers', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 'h1', role: 'host', iceServers: [] });
    bridge.$emit('anywhere.onLinkSignal', {
      sessionId: 'h1',
      payload: JSON.stringify({
        k: 'sdp',
        type: 'answer',
        sdp: 'v=0\r\na=fingerprint:sha-256 ee\r\n',
      }),
    });
    await flush();
    await flush();

    expect(FakePeer.all[0].remoteDescription).toBeNull();
    expect(bridge.$fn('anywhere.linkClosed')).toHaveBeenCalledWith('h1', expect.any(String));
  });

  it('reports the certificate DTLS verified, not a fingerprint placed first in the SDP', async () => {
    const bridge = currentBridge();
    bridge.$emit('anywhere.onLinkStart', { sessionId: 'c2', role: 'controller', iceServers: [] });
    await flush();
    const peer = FakePeer.all[0];
    // The hub's own certificate terminates DTLS, while an extra first section names the peer's.
    const hubCertificate = new Uint8Array([1, 2, 3, 4]).buffer;
    (peer as unknown as { sctp: unknown }).sctp = {
      transport: { getRemoteCertificates: () => [hubCertificate] },
    };
    bridge.$emit('anywhere.onLinkSignal', {
      sessionId: 'c2',
      payload: JSON.stringify({
        k: 'sdp',
        type: 'answer',
        sdp: 'v=0\r\nm=audio\r\na=fingerprint:sha-256 11:22:33\r\nm=application\r\na=fingerprint:sha-256 99:99\r\n',
      }),
    });
    await flush();

    peer.channel?.open();
    await flush();
    await flush();

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', hubCertificate));
    const expected = [...digest].map((b) => b.toString(16).padStart(2, '0').toUpperCase());
    expect(bridge.$fn('anywhere.linkOpened')).toHaveBeenCalledWith('c2', {
      local: 'sha-256 AA:BB:CC',
      remote: `sha-256 ${expected.join(':')}`,
    });
  });
});

describe('fingerprintOf', () => {
  it('reads the DTLS fingerprint from an SDP the same way on both sides', () => {
    expect(fingerprintOf('v=0\r\na=fingerprint:SHA-256 ab:cd\r\n')).toBe('sha-256 AB:CD');
    expect(fingerprintOf('v=0\r\n')).toBe('');
  });

  it('trusts no fingerprint when the sections of an SDP name different ones', () => {
    const sdp =
      'v=0\r\na=fingerprint:sha-256 aa:aa\r\nm=application\r\na=fingerprint:sha-256 bb:bb\r\n';
    expect(fingerprintOf(sdp)).toBe('');
    const same =
      'v=0\r\na=fingerprint:sha-256 aa:aa\r\nm=application\r\na=fingerprint:SHA-256 AA:AA\r\n';
    expect(fingerprintOf(same)).toBe('sha-256 AA:AA');
  });
});
