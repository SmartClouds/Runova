import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { electronState, resetElectronMock, setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { type PeerSocket, SOCKET_CLOSED, SOCKET_OPEN } from './peerSocket';

const injector = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  apply: vi.fn(),
  isSupported: vi.fn(() => true),
}));
vi.mock('./inputInjector', () => ({
  InputInjector: class {
    start = injector.start;
    stop = injector.stop;
    apply = injector.apply;
    isSupported = injector.isSupported;
  },
}));

const sent = vi.hoisted(() => ({ calls: [] as { channel: string; payload: unknown }[] }));
vi.mock('../ipc/send', () => ({
  sendToWindow: (_target: unknown, channel: string, payload: unknown) =>
    sent.calls.push({ channel, payload }),
}));

const { RemoteManager } = await import('./manager');

/** A connection whose messages the test reads and whose incoming side it drives. */
class FakeSocket implements PeerSocket {
  readyState = SOCKET_OPEN;
  bufferedAmount = 0;
  readonly out: (Record<string, unknown> | Uint8Array)[] = [];
  private message: ((data: Buffer, isBinary: boolean) => void) | null = null;
  private closeListener: (() => void) | null = null;

  send(
    data: string | Uint8Array,
    _options?: { binary?: boolean },
    cb?: (err?: Error) => void,
  ): void {
    this.out.push(typeof data === 'string' ? (JSON.parse(data) as Record<string, unknown>) : data);
    cb?.();
  }

  close(): void {
    if (this.readyState === SOCKET_CLOSED) return;
    this.readyState = SOCKET_CLOSED;
    this.closeListener?.();
  }

  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void {
    this.message = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  receive(message: Record<string, unknown>): void {
    this.message?.(Buffer.from(JSON.stringify(message)), false);
  }

  controls(): Record<string, unknown>[] {
    return this.out.filter((m): m is Record<string, unknown> => !(m instanceof Uint8Array));
  }

  last(t: string): Record<string, unknown> | undefined {
    return this.controls()
      .filter((m) => m.t === t)
      .at(-1);
  }
}

const ALL = { control: true, clipboard: true, files: true };

beforeEach(() => {
  resetElectronMock();
  setElectronPath('userData', tempDir('runova-manager-'));
  sent.calls.length = 0;
  vi.clearAllMocks();
});

function admit(permissions = ALL, intent: 'control' | 'files' = 'control') {
  const manager = new RemoteManager();
  const socket = new FakeSocket();
  const peerId = manager.attachHostPeer(socket, {
    deviceName: "Kim's laptop",
    address: 'Runova Anywhere',
    intent,
    permissions,
  });
  return { manager, socket, peerId };
}

describe('a Runova Anywhere peer on the host', () => {
  it('is let in at once, since the secure handshake already proved who it is', () => {
    const { manager, socket } = admit();

    expect(socket.last('auth-ok')).toMatchObject({ t: 'auth-ok' });
    expect(manager.getState().peers).toEqual([
      expect.objectContaining({ deviceName: "Kim's laptop", address: 'Runova Anywhere' }),
    ]);
    expect(sent.calls.some((c) => c.channel === IPC.remote.onCaptureStart)).toBe(true);
    expect(injector.start).toHaveBeenCalled();
  });

  it('does not start capturing for a files-only session', () => {
    admit(ALL, 'files');

    expect(sent.calls.some((c) => c.channel === IPC.remote.onCaptureStart)).toBe(false);
  });

  it('applies input only when the session may control, and not while input is paused', () => {
    const viewOnly = admit({ ...ALL, control: false });
    viewOnly.socket.receive({ t: 'input', event: { k: 'text', text: 'hi' } });
    viewOnly.manager.applyRtcInput(viewOnly.peerId, { k: 'text', text: 'hi' });
    expect(injector.apply).not.toHaveBeenCalled();

    const control = admit();
    control.socket.receive({ t: 'input', event: { k: 'text', text: 'hi' } });
    expect(injector.apply).toHaveBeenCalledTimes(1);

    control.manager.setInputPaused(true);
    control.socket.receive({ t: 'input', event: { k: 'text', text: 'again' } });
    control.manager.applyRtcInput(control.peerId, { k: 'text', text: 'again' });
    expect(injector.apply).toHaveBeenCalledTimes(1);
  });

  it('ignores clipboard text from a session without the clipboard, and sends it none', () => {
    const { manager, socket } = admit({ ...ALL, clipboard: false });
    electronState.clipboardText = 'my secret';

    socket.receive({ t: 'clipboard', text: 'pasted' });
    manager.sendClipboard();

    expect(electronState.clipboardText).toBe('my secret');
    expect(socket.last('clipboard')).toBeUndefined();
  });

  it('answers file requests from a session without files with a refusal', () => {
    const { socket } = admit({ ...ALL, files: false });

    socket.receive({
      t: 'file-offer',
      transferId: 't1',
      name: 'x.exe',
      size: 10,
      partSize: 10,
      partCount: 1,
    });
    socket.receive({ t: 'fm-list', reqId: 'r1', path: null });
    socket.receive({ t: 'fm-roots', reqId: 'r2' });
    socket.receive({ t: 'fm-delete', reqId: 'r3', path: 'C:\\' });
    socket.receive({ t: 'file-request', reqId: 'r4', path: 'C:\\secret.txt' });

    expect(socket.last('file-error')).toMatchObject({ transferId: 't1' });
    expect(socket.last('fm-list-reply')).toMatchObject({
      reqId: 'r1',
      entries: [],
      error: expect.any(String),
    });
    expect(socket.last('fm-roots-reply')).toMatchObject({ reqId: 'r2', roots: [] });
    expect(socket.last('fm-ack')).toMatchObject({ reqId: 'r3', ok: false });
    expect(socket.last('file-request-ack')).toMatchObject({ reqId: 'r4', ok: false });
  });

  it('leaves when its connection closes, and capture stops with the last one', () => {
    const { manager, socket } = admit();

    socket.close();

    expect(manager.getState().peers).toEqual([]);
    expect(sent.calls.some((c) => c.channel === IPC.remote.onCaptureStop)).toBe(true);
  });

  it('can be sent away by the person at the computer', () => {
    const { manager, socket, peerId } = admit();

    manager.endHostPeer(peerId);

    expect(socket.last('bye')).toBeDefined();
    expect(socket.readyState).toBe(SOCKET_CLOSED);
    expect(manager.getState().peers).toEqual([]);
  });
});

describe('a Runova Anywhere connection on the controller', () => {
  it('says hello without a token and is connected when the host lets it in', () => {
    const manager = new RemoteManager();
    const socket = new FakeSocket();

    manager.attachClient(socket, { deviceName: 'Sam desk', intent: 'control' });

    expect(socket.last('hello')).toMatchObject({ role: 'controller', intent: 'control' });
    expect(socket.last('auth')).toBeUndefined();
    expect(manager.getState().connection.status).toBe('connecting');

    socket.receive({ t: 'auth-ok', deviceName: 'Sam desk', screen: { width: 1920, height: 1080 } });

    expect(manager.getState().connection).toMatchObject({
      status: 'connected',
      remoteDeviceName: 'Sam desk',
    });
    expect(socket.last('control-start')).toBeDefined();
  });

  it('goes back to idle when the link closes, without trying to redial it', () => {
    const manager = new RemoteManager();
    const socket = new FakeSocket();
    manager.attachClient(socket, { deviceName: 'Sam desk', intent: 'control' });
    socket.receive({ t: 'auth-ok', deviceName: 'Sam desk', screen: { width: 0, height: 0 } });

    socket.close();

    expect(manager.getState().connection.status).toBe('idle');
  });
});
