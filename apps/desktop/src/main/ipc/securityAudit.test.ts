import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { electronState, queueDialog } from '../../test/main/electronMock';
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
  getAuditStatus: vi.fn(async () => ({ installed: true, runsRoot: status.runsRoot })),
  listAuditRuns: vi.fn(async () => []),
  getAuditRun: vi.fn(async () => ({ runName: 'run-1' })),
  prepareAuditRun: vi.fn(async () => ({ runName: 'run-2', outputDir: '/home/x/run-2' })),
  auditRunPath: vi.fn(async () => '/home/x/run-1/REPORT.md'),
  setAuditTriage: vi.fn(async () => ({})),
  setAuditRunsRoot: vi.fn(async (_projectId: string, folder: string | null) => ({
    runsRoot: folder ?? '/home/x',
  })),
}));
const status = vi.hoisted(() => ({ runsRoot: '' }));
vi.mock('../security/aiAudit', () => service);

const userData = useTempUserData();
expectChannelsCovered(IPC.securityAudit);

beforeEach(async () => {
  for (const fn of Object.values(service)) fn.mockClear();
  status.runsRoot = userData.dir;
  await loadIpc(
    () => import('./securityAudit'),
    (module) => module.registerSecurityAuditHandlers(),
  );
});

describe('securityAudit IPC', () => {
  it('reports a project status', async () => {
    await expect(invoke(IPC.securityAudit.status, 'p1')).resolves.toMatchObject({
      installed: true,
    });
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

  it('records a triage decision for one finding', async () => {
    await invoke(IPC.securityAudit.setTriage, 'p1', 'run-1', 'sqli:1', { status: 'fixed' });

    expect(service.setAuditTriage).toHaveBeenCalledWith('p1', 'run-1', 'sqli:1', {
      status: 'fixed',
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

  it('saves the results folder the user picks, opening the picker on the current one', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['/data/audits'] });

    await expect(invoke(IPC.securityAudit.pickRunsRoot, 'p1')).resolves.toEqual({
      runsRoot: '/data/audits',
    });
    expect(electronState.dialogCalls.at(-1)?.args.at(-1)).toMatchObject({
      defaultPath: userData.dir,
      properties: expect.arrayContaining(['openDirectory', 'createDirectory']),
    });
    expect(service.setAuditRunsRoot).toHaveBeenCalledWith('p1', '/data/audits');
  });

  it('opens the picker on the nearest folder there is when the current one is not made yet', async () => {
    status.runsRoot = `${userData.dir}/not-yet/shop`;
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });

    await invoke(IPC.securityAudit.pickRunsRoot, 'p1');

    expect(electronState.dialogCalls.at(-1)?.args.at(-1)).toMatchObject({
      defaultPath: userData.dir,
    });
  });

  it('changes nothing when the picker is cancelled', async () => {
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });

    await expect(invoke(IPC.securityAudit.pickRunsRoot, 'p1')).resolves.toBeNull();
    expect(service.setAuditRunsRoot).not.toHaveBeenCalled();
  });

  it('goes back to the default results folder', async () => {
    await expect(invoke(IPC.securityAudit.resetRunsRoot, 'p1')).resolves.toEqual({
      runsRoot: '/home/x',
    });
    expect(service.setAuditRunsRoot).toHaveBeenCalledWith('p1', null);
  });
});
