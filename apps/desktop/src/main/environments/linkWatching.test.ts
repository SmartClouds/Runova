import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectEnvironment } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';
import { closeSqliteHandlesAfterEach } from '../../test/main/sqliteHandles';

/**
 * The link manager as the app runs it: real files, the real watcher, the store and a window to
 * tell. A change on disk has to reach the saved copy and the window without anyone asking.
 */

const userData = useTempUserData();
closeSqliteHandlesAfterEach();
const PROJECT_ID = 'p1';
let folder = '';
let watching: typeof import('./linkWatching');

beforeEach(async () => {
  folder = tempDir('runova-env-link-');
  userData.writeData('projects.json', [
    { id: PROJECT_ID, name: 'Demo', folderPath: folder, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  await loadIpc(
    () => import('../ipc/environments'),
    (module) => module.registerEnvironmentHandlers(),
  );
  watching = await import('./linkWatching');
});

afterEach(() => {
  watching.stopEnvFileLinks();
});

async function linkedFile(content: string) {
  const environment = await invoke<ProjectEnvironment>(IPC.environments.save, {
    projectId: PROJECT_ID,
    name: 'Production',
    kind: 'production',
  });
  const saved = await invoke<ProjectEnvironment>(IPC.environments.saveFile, {
    environmentId: environment.id,
    fileName: '.env.prod',
    content,
  });
  const path = join(folder, '.env.prod');
  writeFileSync(path, content, 'utf-8');
  await invoke(IPC.environments.linkFile, {
    environmentId: environment.id,
    fileId: saved.files[0].id,
    path: '.env.prod',
  });
  return { environmentId: environment.id, fileId: saved.files[0].id, path };
}

describe('env file links in the running app', () => {
  it('saves a change made on disk and tells the open windows', async () => {
    const win = new FakeBrowserWindow();
    const { environmentId, fileId, path } = await linkedFile('A=1\n');
    const manager = watching.startEnvFileLinks();
    await manager.idle();

    writeFileSync(path, 'A=1\nB=2\n', 'utf-8');
    await vi.waitFor(
      async () => {
        expect(await invoke<string>(IPC.environments.readFile, environmentId, fileId)).toBe(
          'A=1\nB=2\n',
        );
      },
      { timeout: 10_000, interval: 100 },
    );
    await manager.idle();
    expect(win.webContents.sentOn(IPC.environments.onChanged)).toContainEqual([
      { projectId: PROJECT_ID },
    ]);
    const [listed] = await invoke<ProjectEnvironment[]>(IPC.environments.list, PROJECT_ID);
    expect(listed.files[0]).toMatchObject({ origin: 'fileChanged', versionCount: 1 });
  });

  it('starts following a link made while it runs, and remembers what it saw', async () => {
    const manager = watching.startEnvFileLinks();
    await manager.idle();
    await linkedFile('A=1\n');
    // The link was written to the store, which is what wakes the manager.
    await vi.waitFor(
      async () => {
        await manager.idle();
        expect(Object.keys(await readMarks())).toHaveLength(1);
      },
      { timeout: 5_000, interval: 50 },
    );
  });
});

async function readMarks(): Promise<Record<string, unknown>> {
  const { store } = await import('../store');
  return store.getEnvFileLinkMarks();
}
