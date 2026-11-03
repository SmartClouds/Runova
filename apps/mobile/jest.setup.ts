import { afterEach, jest } from '@jest/globals';

/**
 * Native modules the remote client leans on, replaced with fakes. Everything here is a module a
 * test cannot load outside a real device build: storage, the camera, and the WebSocket the
 * controller talks to the desktop over.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  jest.requireActual('@react-native-async-storage/async-storage/jest'),
);

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
  getStringAsync: jest.fn(async () => ''),
}));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
  setOptions: jest.fn(),
}));

/**
 * The camera. `mockCamera` lets a test grant or deny permission and fire a scan, because
 * babel-plugin-jest-hoist only allows names starting with "mock" inside a factory.
 */
export const mockCamera: {
  lastProps: Record<string, unknown> | null;
  permission: { granted: boolean } | null;
  request: () => Promise<{ granted: boolean }>;
} = {
  lastProps: null,
  permission: { granted: true },
  request: async () => ({ granted: true }),
};

jest.mock('expo-camera', () => {
  const react = jest.requireActual('react') as typeof import('react');
  return {
    CameraView: (props: Record<string, unknown>) => {
      mockCamera.lastProps = props;
      return react.createElement('CameraView', { testID: 'camera-view' });
    },
    useCameraPermissions: () => [mockCamera.permission, mockCamera.request],
  };
});

/** A WebSocket the test drives: `FakeWebSocket.last()` then `serverMessage(...)`. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static last(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error('nothing opened a WebSocket');
    return socket;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = this.CLOSED;
    this.onclose?.({ code, reason });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === 'open') this.onopen = listener;
    if (type === 'message') this.onmessage = listener as (event: { data: unknown }) => void;
    if (type === 'close')
      this.onclose = listener as (event: { code: number; reason: string }) => void;
    if (type === 'error') this.onerror = listener;
  }

  removeEventListener(): void {
    return undefined;
  }

  /** The host accepted the connection. */
  serverOpen(): void {
    this.readyState = this.OPEN;
    this.onopen?.({});
  }

  /** One message from the host. Objects are sent as JSON, like the real host does. */
  serverMessage(payload: unknown): void {
    const data =
      typeof payload === 'string' || payload instanceof ArrayBuffer
        ? payload
        : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  serverClose(code = 1006, reason = 'gone'): void {
    this.readyState = this.CLOSED;
    this.onclose?.({ code, reason });
  }

  serverError(): void {
    this.onerror?.(new Error('socket failed'));
  }
}

const globalWithSocket = globalThis as { WebSocket?: unknown };
globalWithSocket.WebSocket = FakeWebSocket;

afterEach(() => {
  FakeWebSocket.reset();
  mockCamera.lastProps = null;
  mockCamera.permission = { granted: true };
});
