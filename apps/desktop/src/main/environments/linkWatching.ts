import { stat } from 'node:fs/promises';
import { IPC } from '../../shared/ipcChannels';
import { createFileWatcher } from '../fs/openFileWatcher';
import { broadcastToWindows } from '../ipc/send';
import { onVaultUnlocked } from '../ssh/vault';
import { onStoreWrite, store } from '../store';
import { createEnvFileLinkManager, type EnvFileLinkManager } from './fileLinks';
import { setEnvFileLinkState } from './linkStates';
import { linkedEnvFiles, onLinkedFileWritten, updateEnvFileFromDisk } from './service';

/**
 * Runs the env file link manager for the app: real watchers on the project folders, the vault's
 * unlock, and a push to every window when a linked file changed something. It looks again at the
 * links whenever the environments or the projects are written, whoever wrote them (the
 * Environments tab, a sync pull, a project's folder being moved).
 */

let running: { manager: EnvFileLinkManager; stop: () => void } | null = null;

const WATCHED_STORE_FILES = new Set(['project-environments.json', 'projects.json']);

export function startEnvFileLinks(): EnvFileLinkManager {
  if (running) return running.manager;
  const manager = createEnvFileLinkManager({
    listLinked: linkedEnvFiles,
    updateFromDisk: updateEnvFileFromDisk,
    stat: async (path) => {
      try {
        const info = await stat(path);
        return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null;
      } catch {
        return null;
      }
    },
    watch: (path, onChange) => createFileWatcher(path, () => onChange()),
    onVaultUnlocked,
    loadMarks: () => store.getEnvFileLinkMarks(),
    saveMarks: (marks) => store.setEnvFileLinkMarks(marks),
    setState: setEnvFileLinkState,
    notify: (projectId) => broadcastToWindows(IPC.environments.onChanged, { projectId }),
  });
  const stopStore = onStoreWrite((fileName) => {
    if (WATCHED_STORE_FILES.has(fileName)) void manager.reconcile();
  });
  const stopWrites = onLinkedFileWritten((fileId) => void manager.recheck(fileId));
  running = {
    manager,
    stop: () => {
      stopStore();
      stopWrites();
      manager.stop();
    },
  };
  void manager.reconcile();
  return manager;
}

export function stopEnvFileLinks(): void {
  running?.stop();
  running = null;
}
