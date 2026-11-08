import { HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import type {
  AnywhereIntent,
  AnywhereMode,
  AnywherePlatform,
  AnywhereRelation,
} from '../../../shared/anywhere';

export interface HubConnectResult {
  status: 'ringing' | 'offline' | 'unavailable' | 'rate-limited' | 'self';
  sessionId: string | null;
  relation: AnywhereRelation | null;
  host: {
    remoteId: string;
    name: string;
    platform: AnywherePlatform;
    kind: string;
    identityKey: string;
  } | null;
}

export interface HubIncomingRequest {
  sessionId: string;
  mode: AnywhereMode;
  relation: AnywhereRelation;
  intent: AnywhereIntent;
  controller: {
    userId: number;
    displayName: string;
    email: string;
    deviceName: string | null;
    platform: string | null;
    remoteId: string | null;
    identityKey: string | null;
  };
  teams: string[];
}

export interface AnywhereHubHandlers {
  incoming(request: HubIncomingRequest): void;
  resolved(resolved: { sessionId: string; accepted: boolean; reason: string | null }): void;
  signal(sessionId: string, payload: string): void;
  ended(ended: { sessionId: string; reason: string }): void;
  presence(presence: { deviceId: number; remoteId: string; online: boolean }): void;
  /** The connection came back after a drop: go online again. */
  reconnected(): void;
  /** The connection is down; it keeps trying on its own. */
  disconnected(): void;
}

/** The website's remote hub (E60), as the Anywhere service uses it. */
export interface AnywhereHub {
  start(handlers: AnywhereHubHandlers): Promise<void>;
  stop(): Promise<void>;
  goOnline(deviceId: number): Promise<void>;
  requestConnect(request: {
    remoteId: string;
    mode: AnywhereMode;
    controllerDeviceId: number | null;
    intent: AnywhereIntent;
  }): Promise<HubConnectResult>;
  respond(sessionId: string, accept: boolean): Promise<void>;
  signal(sessionId: string, payload: string): Promise<void>;
  connected(sessionId: string, transport: 'direct' | 'relay'): Promise<void>;
  end(sessionId: string): Promise<void>;
  /** A one-time ticket for this side of an accepted session to meet the other on the relay (E62). */
  relayTicket(sessionId: string): Promise<{ path: string; ticket: string }>;
}

/** After a drop: at once, then a little longer each time, and every 30 seconds from then on. */
const RECONNECT_DELAYS_MS = [0, 1_000, 5_000, 15_000, 30_000];
const RETRY_START_MS = 30_000;

export function websiteAnywhereHub(input: {
  siteUrl: string;
  accessToken: () => Promise<string>;
  log?: (message: string) => void;
}): AnywhereHub {
  const connection = new HubConnectionBuilder()
    .withUrl(`${input.siteUrl}/hubs/remote`, {
      accessTokenFactory: input.accessToken,
      // Signaling carries addresses; nothing of it goes to a log.
      logMessageContent: false,
    })
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (context) =>
        RECONNECT_DELAYS_MS[Math.min(context.previousRetryCount, RECONNECT_DELAYS_MS.length - 1)],
    })
    .configureLogging(LogLevel.None)
    .build();
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let wired = false;

  async function connect(first: boolean, handlers: AnywhereHubHandlers): Promise<void> {
    try {
      await connection.start();
      if (!first) handlers.reconnected();
    } catch (error) {
      input.log?.(`[anywhere] the remote hub did not connect: ${String(error)}`);
      if (!stopped)
        retry = setTimeout(
          () => void connect(false, handlers).catch(() => undefined),
          RETRY_START_MS,
        );
      if (first) throw error;
    }
  }

  return {
    async start(handlers) {
      stopped = false;
      if (!wired) {
        wired = true;
        connection.on('IncomingRequest', (request: HubIncomingRequest) =>
          handlers.incoming(request),
        );
        connection.on('RequestResolved', (resolved) => handlers.resolved(resolved));
        connection.on('Signal', (sessionId: string, payload: string) =>
          handlers.signal(sessionId, payload),
        );
        connection.on('SessionEnded', (ended) => handlers.ended(ended));
        connection.on('PresenceChanged', (presence) => handlers.presence(presence));
        connection.onreconnected(() => handlers.reconnected());
        connection.onreconnecting(() => handlers.disconnected());
        connection.onclose(() => {
          if (!stopped) handlers.disconnected();
        });
      }
      if (connection.state === HubConnectionState.Disconnected) await connect(true, handlers);
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      await connection.stop();
    },
    goOnline: (deviceId) => connection.invoke('GoOnline', deviceId),
    requestConnect: (request) => connection.invoke<HubConnectResult>('RequestConnect', request),
    respond: (sessionId, accept) => connection.invoke('Respond', sessionId, accept),
    signal: (sessionId, payload) => connection.invoke('Signal', sessionId, payload),
    connected: (sessionId, transport) => connection.invoke('Connected', sessionId, transport),
    end: (sessionId) => connection.invoke('End', sessionId),
    relayTicket: (sessionId) =>
      connection.invoke<{ path: string; ticket: string }>('CreateRelayTicket', sessionId),
  };
}
