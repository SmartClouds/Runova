import { HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import type { LiveUpdate } from '@/lib/account/monitoring';
import { antiforgeryToken, XSRF_HEADER } from '@/lib/admin/api';

/** Live: connected. Connecting: the first try, or coming back after a drop. Away: given up for now. */
export type LiveState = 'connecting' | 'live' | 'away';

export interface LiveHandlers {
  updated: (update: LiveUpdate) => void;
  /** A scope's monitors were added, changed or removed, or the page came back: read them again. */
  changed: () => void;
  state: (state: LiveState) => void;
}

/** After a drop: at once, then a little longer each time, and every 30 seconds from then on. */
const RETRY_MS = [0, 2_000, 10_000, 30_000];

/**
 * The notifications hub with the session cookie (E57). SignalR reconnects by itself after a drop;
 * a first connection that fails is tried again every 30 seconds. The negotiation is a POST with
 * the cookie, so it carries the antiforgery header like every other unsafe call.
 */
export function connectMonitoringHub(handlers: LiveHandlers): () => void {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let connection: ReturnType<HubConnectionBuilder['build']> | null = null;

  async function start(): Promise<void> {
    if (stopped) return;
    handlers.state('connecting');
    const token = await antiforgeryToken();
    const built = new HubConnectionBuilder()
      .withUrl('/hubs/notifications', {
        headers: token ? { [XSRF_HEADER]: token } : {},
        withCredentials: true,
      })
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (context) =>
          RETRY_MS[Math.min(context.previousRetryCount, RETRY_MS.length - 1)],
      })
      .configureLogging(LogLevel.None)
      .build();
    built.on('CloudMonitorUpdated', (update: LiveUpdate) => handlers.updated(update));
    built.on('CloudMonitorsChanged', () => handlers.changed());
    built.onreconnecting(() => handlers.state('connecting'));
    built.onreconnected(() => {
      handlers.state('live');
      handlers.changed();
    });
    built.onclose(() => {
      if (stopped) return;
      handlers.state('away');
      retry = setTimeout(() => void start(), RETRY_MS[RETRY_MS.length - 1]);
    });
    connection = built;
    try {
      await built.start();
      if (stopped) {
        await built.stop();
        return;
      }
      handlers.state('live');
    } catch {
      if (stopped) return;
      handlers.state('away');
      retry = setTimeout(() => void start(), RETRY_MS[RETRY_MS.length - 1]);
    }
  }

  void start();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    if (connection && connection.state !== HubConnectionState.Disconnected) void connection.stop();
  };
}
