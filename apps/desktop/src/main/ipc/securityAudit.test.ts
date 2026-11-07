import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { electronState } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The AI audit channels hand straight through to main/security/aiAudit.ts (tested on its own).
 * What is checked here is the wiring, and that opening a path only ever opens one main resolved.
 */

const service = vi.hoisted(() => ({
  getAuditStatus: vi.fn(async () => ({ installed: true })),
  listAuditRuns: vi.fn(async () => []),
  getAuditRun: vi.fn(async () => ({ runName: 'run-1' })),
  prepareAuditRun: vi.fn(async () => ({ runName: 'run-2', outputDir: '/home/x/run-2' })),
  auditRunPath: vi.fn(async () => '/home/x/run-1/REPORT.md'),
}));
vi.mock('../security/aiAudit', () => service);

useTempUserData();
expectChannelsCovered(IPC.securityAudit);

beforeEach(async () => {
  for (const fn of Object.values(service)) fn.mockClear();
  await loadIpc(
    () => import('./securityAudit'),
    (module) => module.registerSecurityAuditHandlers(),
  );
});

describe('securityAudit IPC', () => {
  it('reports a project status', async () => {
    await expect(invoke(IPC.securityAudit.status, 'p1')).resolves.toEqual({ installed: true });
    expect(service.getAuditStatus).toHaveBeenCalledWith('p1');
  });

  it('lists runs and reads one', async () => {
    await invoke(IPC.securityAudit.listRuns, 'p1');
    await invoke(IPC.securityAudit.getRun, 'p1', 'run-1');

    expect(service.listAuditRuns).toHaveBeenCalledWith('p1');
    expect(service.getAuditRun).toHaveBeenCalledWith('p1', 'run-1');
  });

  it('prepares the next run folder', async () => {
    await expect(invoke(IPC.securityAudit.prepareRun, 'p1')).resolves.toEqual({
      runName: 'run-2',
      outputDir: '/home/x/run-2',
    });
  });

  it('opens the path main resolved, never one from the caller', async () => {
    await invoke(IPC.securityAudit.openPath, 'p1', 'run-1', 'report');

    expect(service.auditRunPath).toHaveBeenCalledWith('p1', 'run-1', 'report');
    expect(electronState.openedPaths).toContain('/home/x/run-1/REPORT.md');
  });

  it('only opens a run folder or its report', async () => {
    await expect(invoke(IPC.securityAudit.openPath, 'p1', 'run-1', 'anything')).rejects.toThrow(
      /folder or report/i,
    );
    expect(service.auditRunPath).not.toHaveBeenCalled();
  });
});
