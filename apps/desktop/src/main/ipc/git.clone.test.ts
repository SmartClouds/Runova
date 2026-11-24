import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloneJob, StartCloneResult } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * Background clones over IPC. The clone itself is faked (an address has to be on github.com,
 * which a test can't reach); the folder checks, the job list and the broadcasts are real.
 */

const userData = useTempUserData();

const clone = vi.hoisted(() => ({
  finish: null as null | ((outcome: { ok: boolean; message: string }) => void),
  calls: [] as { folder: string; url: string; attach: boolean }[],
}));
vi.mock('../git/cloneRepo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../git/cloneRepo')>();
  return {
    ...real,
    cloneOrAttach: vi.fn(
      (folder: string, url: string, attach: boolean) =>
        new Promise((resolve) => {
          clone.calls.push({ folder, url, attach });
          clone.finish = resolve;
        }),
    ),
  };
});
const notifications = vi.hoisted(() => ({ showOsNotification: vi.fn() }));
vi.mock('../notifications/osNotification', () => notifications);
vi.mock('../pipelines/watcher', () => ({ schedulePipelineCheck: vi.fn() }));

let folder: string;
let window: InstanceType<typeof BrowserWindow>;

function lastBroadcast(): CloneJob[] {
  const sent = (window.webContents as unknown as { sentOn: (c: string) => unknown[][] }).sentOn(
    IPC.git.onCloneJobs,
  );
  return (sent.at(-1)?.[0] ?? []) as CloneJob[];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  clone.calls = [];
  clone.finish = null;
  vi.clearAllMocks();
  folder = join(tempDir('runova-clone-ipc-'), 'app');
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'My app',
      folderPath: folder,
      repoUrl: 'https://github.com/acme/my-app',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  window = new BrowserWindow();
  await loadIpc(
    () => import('./git'),
    (module) => module.registerGitHandlers(),
  );
});

describe('background clone IPC', () => {
  it('starts a clone, lists it, and tells the windows', async () => {
    const result = await invoke<StartCloneResult>(IPC.git.startClone, { projectId: 'p1' });

    expect(result).toMatchObject({ ok: true, job: { projectId: 'p1', status: 'running' } });
    expect(clone.calls).toEqual([{ folder, url: 'https://github.com/acme/my-app', attach: false }]);
    expect(await invoke<CloneJob[]>(IPC.git.cloneJobs)).toEqual([
      expect.objectContaining({ id: result.job?.id, repoLabel: 'acme/my-app' }),
    ]);
    expect(lastBroadcast()).toEqual([expect.objectContaining({ status: 'running' })]);
  });

  it('saves a typed address once the clone works, and notifies while in the background', async () => {
    await invoke(IPC.git.startClone, { projectId: 'p1', repoUrl: 'github.com/acme/renamed' });
    clone.finish?.({ ok: true, message: 'Cloned it.' });
    // Saving the address goes through the project store's disk write first.
    await vi.waitFor(() =>
      expect(lastBroadcast()[0]).toMatchObject({ status: 'succeeded', percent: 100 }),
    );
    const stored = JSON.parse(readFileSync(userData.dataFile('projects.json'), 'utf-8'));
    expect(stored[0].repoUrl).toBe('https://github.com/acme/renamed');
    // The fake has no window in front, so the OS gets told.
    expect(notifications.showOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My app is ready', route: '/projects/p1?tab=git' }),
    );
  });

  it('asks before connecting a folder that already has files', async () => {
    writeTree(folder, { 'notes.txt': 'mine\n' });

    const result = await invoke<StartCloneResult>(IPC.git.startClone, { projectId: 'p1' });

    expect(result).toMatchObject({ ok: false, needsAttachConfirm: true });
    expect(clone.calls).toEqual([]);
  });

  it('stops a running clone and then lets the finished job be dismissed', async () => {
    const { job } = await invoke<StartCloneResult>(IPC.git.startClone, { projectId: 'p1' });
    const id = job?.id as string;

    expect(await invoke(IPC.git.dismissClone, id)).toBe(false);
    expect(await invoke(IPC.git.cancelClone, id)).toBe(true);
    clone.finish?.({ ok: false, message: 'Clone stopped.' });
    await settle();
    expect(lastBroadcast()[0]).toMatchObject({ status: 'cancelled' });

    expect(await invoke(IPC.git.dismissClone, id)).toBe(true);
    expect(lastBroadcast()).toEqual([]);
  });

  it('refuses an address that is not on GitHub', async () => {
    const result = await invoke<StartCloneResult>(IPC.git.startClone, {
      projectId: 'p1',
      repoUrl: 'file:///C:/secret/repo',
    });

    expect(result.ok).toBe(false);
    expect(clone.calls).toEqual([]);
  });
});
