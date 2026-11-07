import { HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import type { ServerNotification } from '../../shared/dependencyAlerts';
import type { CloudMonitorLive } from '../health/cloud';
import type { AlertHub } from './service';

/** After a drop: at once, then a little longer each time, and every minute from then on. */
const RECONNECT_DELAYS_MS = [0, 2_000, 10_000, 30_000, 60_000];
const RETRY_START_MS = 60_000;

/**
 * The website's notifications hub (E51), with the device token. Automatic reconnect covers a
 * dropped connection; a first connection that fails is tried again every minute, since the
 * automatic one only starts once a connection has been made.
 */
export function websiteAlertHub(input: {
  siteUrl: string;
  accessToken: () => Promise<string>;
  log?: (message: string) => void;
}): AlertHub {
  const connection = new HubConnectionBuilder()
    .withUrl(`${input.siteUrl}/hubs/notifications`, {
      accessTokenFactory: input.accessToken,
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
  const reconnected: (() => void)[] = [];

  /** The first try tells nobody; a later one that works counts as coming back, so the app catches up. */
  async function connect(first: boolean): Promise<void> {
    try {
      await connection.start();
      if (!first) for (const handler of reconnected) handler();
    } catch (error) {
      input.log?.(`[dependency-alerts] the hub did not connect: ${String(error)}`);
      if (!stopped)
        retry = setTimeout(() => void connect(false).catch(() => undefined), RETRY_START_MS);
      if (first) throw error;
    }
  }

  connection.onreconnected(() => {
    for (const handler of reconnected) handler();
  });

  return {
    async start() {
      stopped = false;
      if (connection.state === HubConnectionState.Disconnected) await connect(true);
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      await connection.stop();
    },
    onNotification: (handler) =>
      connection.on('NotificationCreated', (notification: ServerNotification) =>
        handler(notification),
      ),
    onSummaryChanged: (handler) => connection.on('DependencySummaryChanged', () => handler()),
    onCloudMonitorUpdated: (handler) =>
      connection.on('CloudMonitorUpdated', (monitor: CloudMonitorLive) => handler(monitor)),
    onCloudMonitorsChanged: (handler) => connection.on('CloudMonitorsChanged', () => handler()),
    onReconnected: (handler) => {
      reconnected.push(handler);
    },
  };
}
