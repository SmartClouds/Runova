import { clipboard, ipcMain } from 'electron';
import type {
  EnvImportPick,
  SaveEnvCredentialInput,
  SaveEnvFileInput,
  SaveEnvironmentInput,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  envCredentialSecret,
  envFileHistory,
  importEnvFromFolder,
  listEnvironments,
  readEnvFile,
  readEnvFileVersion,
  removeEnvCredential,
  removeEnvFile,
  removeEnvironment,
  reorderEnvironments,
  restoreEnvFileVersion,
  revealEnvCredential,
  saveEnvCredential,
  saveEnvFile,
  saveEnvironment,
  scanEnvFolder,
  writeEnvToFolder,
} from '../environments/service';

/**
 * The Environments tab's side of a project's environments. The work lives in
 * environments/service.ts, which AI access calls too.
 */
export {
  type ResolvedEnvFile,
  type ResolvedProjectEnvironment,
  resolveProjectEnvironment,
  toPublicEnvironment,
} from '../environments/service';

export function registerEnvironmentHandlers(): void {
  ipcMain.handle(IPC.environments.list, (_event, projectId: string) => listEnvironments(projectId));
  ipcMain.handle(IPC.environments.save, (_event, input: SaveEnvironmentInput) =>
    saveEnvironment(input),
  );
  ipcMain.handle(IPC.environments.remove, (_event, id: string) => removeEnvironment(id));
  ipcMain.handle(IPC.environments.reorder, (_event, projectId: string, orderedIds: string[]) =>
    reorderEnvironments(projectId, orderedIds),
  );
  ipcMain.handle(IPC.environments.saveFile, (_event, input: SaveEnvFileInput) =>
    saveEnvFile(input),
  );
  ipcMain.handle(IPC.environments.removeFile, (_event, environmentId: string, fileId: string) =>
    removeEnvFile(environmentId, fileId),
  );
  ipcMain.handle(IPC.environments.readFile, (_event, environmentId: string, fileId: string) =>
    readEnvFile(environmentId, fileId),
  );
  // Copying happens here so the plaintext never has to pass through the renderer.
  ipcMain.handle(
    IPC.environments.copyFile,
    async (_event, environmentId: string, fileId: string): Promise<void> => {
      clipboard.writeText(await readEnvFile(environmentId, fileId));
    },
  );
  ipcMain.handle(IPC.environments.fileHistory, (_event, environmentId: string, fileId: string) =>
    envFileHistory(environmentId, fileId),
  );
  ipcMain.handle(
    IPC.environments.readFileVersion,
    (_event, environmentId: string, fileId: string, versionId: string) =>
      readEnvFileVersion(environmentId, fileId, versionId),
  );
  ipcMain.handle(
    IPC.environments.restoreFileVersion,
    (_event, environmentId: string, fileId: string, versionId: string) =>
      restoreEnvFileVersion(environmentId, fileId, versionId),
  );
  ipcMain.handle(IPC.environments.saveCredential, (_event, input: SaveEnvCredentialInput) =>
    saveEnvCredential(input),
  );
  ipcMain.handle(
    IPC.environments.removeCredential,
    (_event, environmentId: string, credentialId: string) =>
      removeEnvCredential(environmentId, credentialId),
  );
  ipcMain.handle(
    IPC.environments.revealCredential,
    (_event, environmentId: string, credentialId: string) =>
      revealEnvCredential(environmentId, credentialId),
  );
  ipcMain.handle(
    IPC.environments.copyCredentialSecret,
    async (_event, environmentId: string, credentialId: string): Promise<void> => {
      clipboard.writeText(await envCredentialSecret(environmentId, credentialId));
    },
  );
  ipcMain.handle(IPC.environments.scanFolder, (_event, projectId: string) =>
    scanEnvFolder(projectId),
  );
  ipcMain.handle(
    IPC.environments.importFromFolder,
    (_event, projectId: string, picks: EnvImportPick[]) => importEnvFromFolder(projectId, picks),
  );
  ipcMain.handle(
    IPC.environments.writeToFolder,
    (_event, environmentId: string, fileId: string, overwrite: boolean) =>
      writeEnvToFolder(environmentId, fileId, overwrite),
  );
}
