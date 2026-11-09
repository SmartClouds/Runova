import { IPC } from '../../shared/ipcChannels';
import { liveDependencyAlerts } from '../dependencyAlerts/live';
import type { DependencyAlerts } from '../dependencyAlerts/service';
import { getCloudMonitors } from '../health/cloudLive';
import { broadcastToWindows } from '../ipc/send';
import { startNotificationForwarding } from '../notifications/forward';
import { getAnywhere } from '../remote/anywhere/live';
import { remoteManager } from '../remote/manager';
import { endRemoteOnSignOut } from '../remote/signOut';
import { onVaultUnlocked } from '../ssh/vault';
import { liveSyncAdapters, refreshSecretsState } from '../sync/adapters/live';
import type { SyncAdapter } from '../sync/types';
import { type AccountRuntime, createAccountRuntime, syncOnFocus } from './runtime';

/**
 * The app's one account runtime (E48), made on first use. Writes that arrive from another
 * computer are announced on the same channel AI access uses, so every screen already knows which
 * queries to refetch.
 */

let runtime: AccountRuntime | null = null;
let adapters: SyncAdapter[] | null = null;
let alerts: DependencyAlerts | null = null;

/** Dependency alerts (E51) ride on the account: they connect when it signs in and stop when it signs out. */
export function getDependencyAlerts(): DependencyAlerts {
  alerts ??= liveDependencyAlerts(getAccountRuntime());
  return alerts;
}

export function getAccountRuntime(): AccountRuntime {
  if (runtime) return runtime;
  runtime = createAccountRuntime({
    adapters: () => {
      adapters ??= liveSyncAdapters();
      return adapters;
    },
    dataChanged: (area) => broadcastToWindows(IPC.aiAccess.onDataChanged, { area }),
    beforeSync: refreshSecretsState,
    onSignedIn: () => {
      void getDependencyAlerts().start();
      // Runova Anywhere (E61) registers this computer and goes online with the account.
      if (runtime) void getAnywhere(runtime).start();
    },
    onSignedOut: () => {
      void alerts?.stop();
      if (runtime) void getAnywhere(runtime).stop();
      endRemoteOnSignOut(remoteManager);
      // Signed out, an online monitor shows nothing (and is still not checked here).
      void getCloudMonitors().reset();
    },
  });
  const account = runtime;
  startNotificationForwarding({
    api: (method, path, body) => account.api(method, path, body),
    signedIn: async () => (await account.status()).state === 'signed-in',
    // biome-ignore lint/suspicious/noConsole: the only record of a forward that failed
    log: (message) => console.warn(message),
    sealKeys: () => getAnywhere(account).sealKeys(),
  });
  return runtime;
}

/** Starts syncing when this computer is signed in already. An e2e run reaches no real server. */
export async function startAccount(): Promise<void> {
  const account = getAccountRuntime();
  syncOnFocus(account);
  // Secrets that waited for the Servers passkey go out as soon as it opens.
  onVaultUnlocked(() => account.trigger(0));
  await account.start();
  void getAnywhere(account).start();
}

export function stopAccount(): void {
  runtime?.stop();
  void alerts?.stop();
  if (runtime) void getAnywhere(runtime).stop();
}
