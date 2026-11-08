import { describe, expect, it, vi } from 'vitest';
import type { OpenedLink } from './links';
import { createRtcLinkOpener, type RtcLinkBridge, STUN_SERVERS } from './rtcLinks';

function fakeBridge() {
  const calls = {
    start: [] as Parameters<RtcLinkBridge['startPeer']>[0][],
    signals: [] as { sessionId: string; payload: string }[],
    frames: [] as { sessionId: string; frame: Uint8Array }[],
    stops: [] as { sessionId: string; reason: string }[],
  };
  const bridge: RtcLinkBridge = {
    startPeer: (input) => calls.start.push(input),
    deliverSignal: (sessionId, payload) => calls.signals.push({ sessionId, payload }),
    sendFrame: (sessionId, frame) => calls.frames.push({ sessionId, frame }),
    stopPeer: (sessionId, reason) => calls.stops.push({ sessionId, reason }),
  };
  return { bridge, calls };
}

describe('WebRTC links', () => {
  it('starts a peer in the renderer with public STUN servers only', () => {
    const { bridge, calls } = fakeBridge();
    const links = createRtcLinkOpener(bridge);

    void links.open({
      sessionId: 's1',
      role: 'controller',
      relayOnly: false,
      signal: () => undefined,
    });

    expect(calls.start).toEqual([
      { sessionId: 's1', role: 'controller', iceServers: STUN_SERVERS },
    ]);
  });

  it('opens once the data channel is up, with both fingerprints', async () => {
    const { bridge } = fakeBridge();
    const links = createRtcLinkOpener(bridge);
    const opening = links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: () => undefined,
    });

    links.rendererOpened('s1', { local: 'sha-256 AA', remote: 'sha-256 BB' });
    const link = await opening;

    expect(link).toMatchObject({
      kind: 'direct',
      localFingerprint: 'sha-256 AA',
      remoteFingerprint: 'sha-256 BB',
    });
  });

  it('passes frames both ways once open', async () => {
    const { bridge, calls } = fakeBridge();
    const links = createRtcLinkOpener(bridge);
    const opening = links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: () => undefined,
    });
    links.rendererOpened('s1', { local: '', remote: '' });
    const { transport } = await opening;
    const heard: number[][] = [];
    transport.onFrame((frame) => heard.push([...frame]));

    transport.send(new Uint8Array([1, 2]));
    links.rendererFrame('s1', new Uint8Array([3, 4]));
    links.rendererFrame('other', new Uint8Array([9]));

    expect(calls.frames).toEqual([{ sessionId: 's1', frame: new Uint8Array([1, 2]) }]);
    expect(heard).toEqual([[3, 4]]);
  });

  it('reports how much the channel holds, as the renderer last said', async () => {
    const { bridge } = fakeBridge();
    const links = createRtcLinkOpener(bridge);
    const opening = links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: () => undefined,
    });
    links.rendererOpened('s1', { local: '', remote: '' });
    const { transport } = await opening;

    links.rendererBuffered('s1', 70_000);

    expect(transport.bufferedAmount()).toBe(70_000);
  });

  it('sends the renderer signals to the hub, and the hub signals to the renderer, even early ones', async () => {
    const { bridge, calls } = fakeBridge();
    const links = createRtcLinkOpener(bridge);
    const sent: string[] = [];

    links.deliverSignal('s1', '{"k":"sdp","type":"offer"}');
    void links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: (p) => sent.push(p),
    });
    links.rendererSignal('s1', '{"k":"ice"}');
    links.deliverSignal('s1', '{"k":"ice","candidate":"x"}');

    expect(sent).toEqual(['{"k":"ice"}']);
    expect(calls.signals.map((s) => s.payload)).toEqual([
      '{"k":"sdp","type":"offer"}',
      '{"k":"ice","candidate":"x"}',
    ]);
  });

  it('closes the transport when the renderer says the channel closed', async () => {
    const { bridge } = fakeBridge();
    const links = createRtcLinkOpener(bridge);
    const opening = links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: () => undefined,
    });
    links.rendererOpened('s1', { local: '', remote: '' });
    const { transport } = await opening;
    const closes: string[] = [];
    transport.onClose((reason) => closes.push(reason));

    links.rendererClosed('s1', 'ice failed');

    expect(closes).toEqual(['ice failed']);
  });

  it('stops the renderer peer when the transport is closed here', async () => {
    const { bridge, calls } = fakeBridge();
    const links = createRtcLinkOpener(bridge);
    const opening = links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: () => undefined,
    });
    links.rendererOpened('s1', { local: '', remote: '' });
    const { transport } = await opening;

    transport.close('done');

    expect(calls.stops).toEqual([{ sessionId: 's1', reason: 'done' }]);
  });

  it('falls back to the relay when the direct way does not open in time', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, calls } = fakeBridge();
      const relayed: OpenedLink = {
        transport: {
          send: () => undefined,
          bufferedAmount: () => 0,
          close: () => undefined,
          onFrame: () => undefined,
          onClose: () => undefined,
        },
        kind: 'relay',
        localFingerprint: '',
        remoteFingerprint: '',
      };
      const relay = vi.fn(async () => relayed);
      const links = createRtcLinkOpener(bridge, { directTimeoutMs: 8_000, relay });
      const sent: string[] = [];
      const opening = links.open({
        sessionId: 's1',
        role: 'controller',
        relayOnly: false,
        signal: (p) => sent.push(p),
      });

      await vi.advanceTimersByTimeAsync(8_000);

      expect(await opening).toBe(relayed);
      expect(calls.stops).toEqual([{ sessionId: 's1', reason: 'falling back to the relay' }]);
      expect(sent).toContain('{"k":"relay"}');
      expect(relay).toHaveBeenCalledWith({ sessionId: 's1', role: 'controller' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes to the relay when the other side asks to', async () => {
    const { bridge, calls } = fakeBridge();
    const relayed: OpenedLink = {
      transport: {
        send: () => undefined,
        bufferedAmount: () => 0,
        close: () => undefined,
        onFrame: () => undefined,
        onClose: () => undefined,
      },
      kind: 'relay',
      localFingerprint: '',
      remoteFingerprint: '',
    };
    const links = createRtcLinkOpener(bridge, { relay: async () => relayed });
    const opening = links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: () => undefined,
    });

    links.deliverSignal('s1', '{"k":"relay"}');

    expect(await opening).toBe(relayed);
    expect(calls.signals).toEqual([]);
    expect(calls.stops).toHaveLength(1);
  });

  it('uses the relay straight away when asked to, without starting WebRTC', async () => {
    const { bridge, calls } = fakeBridge();
    const links = createRtcLinkOpener(bridge, {
      relay: async () => ({
        transport: {
          send: () => undefined,
          bufferedAmount: () => 0,
          close: () => undefined,
          onFrame: () => undefined,
          onClose: () => undefined,
        },
        kind: 'relay',
        localFingerprint: '',
        remoteFingerprint: '',
      }),
    });
    const sent: string[] = [];

    const link = await links.open({
      sessionId: 's1',
      role: 'controller',
      relayOnly: true,
      signal: (p) => sent.push(p),
    });

    expect(link.kind).toBe('relay');
    expect(calls.start).toEqual([]);
    expect(sent).toEqual(['{"k":"relay"}']);
  });

  it('fails with a clear reason when there is no direct way and no relay', async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = fakeBridge();
      const links = createRtcLinkOpener(bridge, { directTimeoutMs: 100 });
      const opening = links.open({
        sessionId: 's1',
        role: 'controller',
        relayOnly: false,
        signal: () => undefined,
      });
      const assertion = expect(opening).rejects.toThrow(/directly/);

      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a cancelled session', async () => {
    const { bridge, calls } = fakeBridge();
    const links = createRtcLinkOpener(bridge);
    const opening = links.open({
      sessionId: 's1',
      role: 'host',
      relayOnly: false,
      signal: () => undefined,
    });
    const assertion = expect(opening).rejects.toThrow(/cancelled/);

    links.cancel('s1');

    await assertion;
    expect(calls.stops).toEqual([{ sessionId: 's1', reason: 'cancelled' }]);
  });
});
