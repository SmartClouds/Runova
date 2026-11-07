import type { AiAuditRunDetail, AiAuditRunSummary, AiAuditStatus } from '@runova/core';
import { ipcMain, shell } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import {
  auditRunPath,
  getAuditRun,
  getAuditStatus,
  listAuditRuns,
  prepareAuditRun,
} from '../security/aiAudit';

/**
 * The AI security audit's IPC. Like the scanner channels in ./security.ts, every call names a
 * project and a run, and main works out the paths itself.
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
    IPC.securityAudit.openPath,
    async (_event, projectId: string, runName: string, target: unknown): Promise<void> => {
      if (target !== 'folder' && target !== 'report') {
        throw new Error("Only a run's folder or report can be opened.");
      }
      const error = await shell.openPath(await auditRunPath(projectId, runName, target));
      if (error) throw new Error(error);
    },
  );
}
