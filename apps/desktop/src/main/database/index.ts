import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { MAX_ENV_FILE_BYTES } from '@runova/core';
import Database from 'better-sqlite3';
import { app, dialog, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import type { DeployDocker } from '../deploy/docker';
import { registerDatabaseHandlers } from '../ipc/database';
import { sendToWindow } from '../ipc/send';
import { getMainWindow } from '../mainWindow';
import { getSshPool } from '../ssh/sharedPool';
import { registerSealedSecretStore } from '../ssh/vault';
import {
  DatabaseBackups,
  localProcess,
  type ProcessHandle,
  type RunWhere,
  serverCommand,
} from './backup';
import { DatabaseConnectionStore } from './connectionStore';
import { openDriver } from './drivers';
import { readLocalEnvFile, serverEnvCommand } from './envFile';
import { createLocalDocker } from './localDocker';
import { DatabaseService, setDatabaseService } from './service';

/**
 * The Database section (E45) in main: saved connections sealed with the Servers vault, server
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
    readEnvFile: async (serverId, path) => {
      if (!serverId) return readLocalEnvFile(path);
      const lease = await pool.acquire(serverId);
      try {
        const result = await lease.connection.exec(serverEnvCommand(path), {
          timeoutMs: 15_000,
          maxOutputBytes: MAX_ENV_FILE_BYTES + 1,
        });
        if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > MAX_ENV_FILE_BYTES) {
          return null;
        }
        return result.stdout;
      } finally {
        lease.release();
      }
    },
    // Docker Desktop on Windows and macOS runs containers in a VM this computer cannot route to.
    containerAddressesReachable: process.platform === 'linux',
  });
  const openOnServer = async (
    where: Exclude<RunWhere, { kind: 'localContainer' }>,
    script: string,
  ): Promise<ProcessHandle> => {
    const lease = await pool.acquire(where.serverId);
    try {
      const channel = (await lease.connection.openExecStream(serverCommand(where, script), {
        timeoutMs: 30_000,
      })) as unknown as ProcessHandle['stdin'] &
        Readable & {
          stderr: Readable;
          close: () => void;
          once: (event: string, cb: (code: number | null) => void) => void;
        };
      const exited = new Promise<number | null>((resolve) => {
        channel.once('exit', (code: number | null) => resolve(code ?? null));
        channel.once('close', () => resolve(null));
      });
      void exited.finally(() => lease.release());
      return {
        stdin: channel,
        stdout: channel,
        stderr: channel.stderr,
        exited,
        kill: () => channel.close(),
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  };
  const backups = new DatabaseBackups({
    source: {
      connection: (connectionId) => connections.summary(connectionId),
      password: (connectionId) => connections.password(connectionId),
    },
    folder: (connectionId) =>
      join(app.getPath('userData'), 'data', 'database-backups', connectionId),
    open: async (where, script) =>
      where.kind === 'localContainer'
        ? localProcess(where.containerId, script)
        : openOnServer(where, script),
    progress: (event) => sendToWindow(getMainWindow(), IPC.database.onBackupProgress, event),
    copySqlite: async (from, to) => {
      const db = new Database(from, { readonly: true, fileMustExist: true });
      try {
        db.prepare('VACUUM INTO ?').run(to);
      } finally {
        db.close();
      }
    },
  });
  registerDatabaseHandlers({
    ipc: ipcMain,
    service,
    guard,
    backups: {
      list: (connectionId) => backups.list(connectionId),
      backup: (connectionId) => backups.backup(connectionId),
      restore: (connectionId, name) => backups.restore(connectionId, { name }),
      restoreFromFile: async (connectionId) => {
        const window = getMainWindow();
        const options = {
          title: 'Restore from a backup file',
          properties: ['openFile' as const],
        };
        const picked = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        const path = picked.filePaths[0];
        if (picked.canceled || !path) return false;
        await backups.restore(connectionId, { path });
        return true;
      },
      remove: (connectionId, name) => backups.remove(connectionId, name),
      reveal: (connectionId, name) => shell.showItemInFolder(backups.fileIn(connectionId, name)),
    },
  });
  setDatabaseService(service);
  app.on('will-quit', () => void service.disconnectAll());
  return service;
}
