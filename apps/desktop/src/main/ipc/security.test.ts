import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * The project Security tab's IPC. These cover the two behaviors the tab depends on that the
 * contract test cannot see: Refresh has to re-probe rather than answer from the 30 second cache,
 * and a project never runs two scans at once.
 */

const preflight = vi.hoisted(() => ({
  checkAllPreflight: vi.fn(async () => []),
  clearPreflightCache: vi.fn(),
}));

const runner = vi.hoisted(() => ({
  active: null as null | { runId: string },
  runSecurityScan: vi.fn(async () => ({ id: 'run-1' })),
}));

vi.mock('../security/preflight', () => preflight);
vi.mock('../security/scanRunner', () => ({
  cancelSecurityScan: vi.fn(() => true),
  getActiveScan: () => runner.active,
  newScanRunId: () => 'generated-id',
  runSecurityScan: runner.runSecurityScan,
}));

const userData = useTempUserData();

beforeEach(async () => {
  preflight.checkAllPreflight.mockClear();
  preflight.clearPreflightCache.mockClear();
  runner.runSecurityScan.mockClear();
  runner.active = null;
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: '/work/shop', createdAt: '2026-11-01T00:00:00Z' },
  ]);
  await loadIpc(
    () => import('./security'),
    (module) => module.registerSecurityHandlers(),
  );
});

describe('security preflight', () => {
  it('answers from the cache on a normal call', async () => {
    await invoke(IPC.security.preflight, 'p1');

    expect(preflight.clearPreflightCache).not.toHaveBeenCalled();
    expect(preflight.checkAllPreflight).toHaveBeenCalledTimes(1);
  });

  it('drops the cache first when the user asks for a fresh check', async () => {
    await invoke(IPC.security.preflight, 'p1', { force: true });

    expect(preflight.clearPreflightCache).toHaveBeenCalledTimes(1);
    const clearedAt = preflight.clearPreflightCache.mock.invocationCallOrder[0];
    const checkedAt = preflight.checkAllPreflight.mock.invocationCallOrder[0];
    expect(clearedAt).toBeLessThan(checkedAt);
  });
});

describe('security runScan', () => {
  it('starts a scan when none is running', async () => {
    await invoke(IPC.security.runScan, 'p1', { scannerIds: ['semgrep'] }, 'run-a');

    expect(runner.runSecurityScan).toHaveBeenCalledWith(
      'run-a',
      expect.objectContaining({ projectId: 'p1' }),
    );
  });

  it('refuses a second scan while one is running on the project', async () => {
    runner.active = { runId: 'run-a' };

    await expect(
      invoke(IPC.security.runScan, 'p1', { scannerIds: ['semgrep'] }, 'run-b'),
    ).rejects.toThrow(/already running/i);
    expect(runner.runSecurityScan).not.toHaveBeenCalled();
  });
});
