import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AiAuditRunDetail,
  AiAuditRunSummary,
  AiAuditStatus,
  AiAuditTriage,
} from '@runova/core';
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions, shell } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import {
  auditRunPath,
  getAuditRun,
  getAuditStatus,
  listAuditRuns,
  prepareAuditRun,
  setAuditRunsRoot,
  setAuditTriage,
} from '../security/aiAudit';

/** The folder itself, or the nearest one above it that exists, for the picker to open on. */
function nearestExisting(folder: string): string | undefined {
  let current = folder;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

/**
 * The AI security audit's IPC. Like the scanner channels in ./security.ts, every call names a
 * project and a run, and main works out the paths itself. Even the results folder is picked in
 * main's own dialog, so the page never hands over a path to write to.
 */
export function registerSecurityAuditHandlers(): void {
  ipcMain.handle(
    IPC.securityAudit.status,
    (_event, projectId: string): Promise<AiAuditStatus> => getAuditStatus(projectId),
  );

  ipcMain.handle(
    IPC.securityAudit.listRuns,
    (_event, projectId: string): Promise<AiAuditRunSummary[]> => listAuditRuns(projectId),
  );

  ipcMain.handle(
    IPC.securityAudit.getRun,
    (_event, projectId: string, runName: string): Promise<AiAuditRunDetail> =>
      getAuditRun(projectId, runName),
  );

  ipcMain.handle(
    IPC.securityAudit.prepareRun,
    (_event, projectId: string): Promise<{ runName: string; outputDir: string }> =>
      prepareAuditRun(projectId),
  );

  ipcMain.handle(
    IPC.securityAudit.setTriage,
    (
      _event,
      projectId: string,
      runName: string,
      fingerprint: unknown,
      change: unknown,
    ): Promise<AiAuditTriage> => setAuditTriage(projectId, runName, fingerprint, change),
  );

  ipcMain.handle(
    IPC.securityAudit.openPath,
    async (_event, projectId: string, runName: string, target: unknown): Promise<void> => {
      if (target !== 'folder' && target !== 'report') {
        throw new Error("Only a run's folder or report can be opened.");
      }
      const error = await shell.openPath(await auditRunPath(projectId, runName, target));
      if (error) throw new Error(error);
    },
  );

  ipcMain.handle(
    IPC.securityAudit.pickRunsRoot,
    async (event, projectId: string): Promise<AiAuditStatus | null> => {
      const current = await getAuditStatus(projectId);
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        title: 'Where the audit results go',
        buttonLabel: 'Use this folder',
        defaultPath: nearestExisting(current.runsRoot),
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      const folder = result.canceled ? undefined : result.filePaths[0];
      return folder ? setAuditRunsRoot(projectId, folder) : null;
    },
  );

  ipcMain.handle(
    IPC.securityAudit.resetRunsRoot,
    (_event, projectId: string): Promise<AiAuditStatus> => setAuditRunsRoot(projectId, null),
  );
}
