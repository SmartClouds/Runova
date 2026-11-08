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
    bridge.$emit('anywhere.onLinkFrame', { sessionId: 's4', frame: new Uint8Array([1, 2]) });
    peer.channel?.onmessage?.({ data: new Uint8Array([3, 4]).buffer });

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

describe('fingerprintOf', () => {
  it('reads the DTLS fingerprint from an SDP the same way on both sides', () => {
    expect(fingerprintOf('v=0\r\na=fingerprint:SHA-256 ab:cd\r\n')).toBe('sha-256 AB:CD');
    expect(fingerprintOf('v=0\r\n')).toBe('');
  });
});
