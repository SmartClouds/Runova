import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
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

export function getAccountRuntime(): AccountRuntime {
  runtime ??= createAccountRuntime({
    adapters: () => {
      adapters ??= liveSyncAdapters();
      return adapters;
    },
    dataChanged: (area) => broadcastToWindows(IPC.aiAccess.onDataChanged, { area }),
    beforeSync: refreshSecretsState,
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
}

export function stopAccount(): void {
  runtime?.stop();
}
