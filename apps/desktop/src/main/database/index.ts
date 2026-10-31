import { join } from 'node:path';
import { app, type IpcMainInvokeEvent, ipcMain } from 'electron';
import type { DeployDocker } from '../deploy/docker';
import { registerDatabaseHandlers } from '../ipc/database';
import { getSshPool } from '../ssh/sharedPool';
import { registerSealedSecretStore } from '../ssh/vault';
import { DatabaseConnectionStore } from './connectionStore';
import { openDriver } from './drivers';
import { createLocalDocker } from './localDocker';
import { DatabaseService } from './service';

/**
 * The Database section (E44) in main: saved connections sealed with the Servers vault, server
 * containers through the Containers screen's calls, databases on a server reached over its SSH
 * connection, and every session closed when the app quits.
 */
export function registerDatabaseIpc(
  docker: DeployDocker,
  guard: (event: IpcMainInvokeEvent) => boolean,
): DatabaseService {
  const connections = new DatabaseConnectionStore(
    join(app.getPath('userData'), 'data', 'databases.json'),
  );
  registerSealedSecretStore(connections.sealed);
  const pool = getSshPool();
  const service = new DatabaseService({
    connections,
    openDriver,
    serverDocker: docker,
    serverStream: async (serverId, host, port) => {
      const lease = await pool.acquire(serverId);
      try {
        const stream = await lease.connection.openStream({ host, port });
        // The connection stays leased while the stream is open, so the pool does not close it.
        stream.once('close', () => lease.release());
        return stream;
      } catch (error) {
        lease.release();
        throw error;
      }
    },
    localDocker: createLocalDocker(),
    // Docker Desktop on Windows and macOS runs containers in a VM this computer cannot route to.
    containerAddressesReachable: process.platform === 'linux',
  });
  registerDatabaseHandlers({ ipc: ipcMain, service, guard });
  app.on('will-quit', () => void service.disconnectAll());
  return service;
}
