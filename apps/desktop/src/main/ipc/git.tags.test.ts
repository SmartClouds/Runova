import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitOpResult, WorkspaceGitState } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { hasGit, initGitRepo } from '../../test/main/fixtures';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * Creating or deleting a tag leaves HEAD where it was, and HEAD is what the workspace commit
 * list used to key on. These run the real handlers against a real repository and check that
 * every open window is handed a state whose tags signature moved, so the list re-reads and the
 * tag chip shows up (or goes away) without a commit or a restart.
 */

const userData = useTempUserData();

vi.mock('../pipelines/watcher', () => ({ schedulePipelineCheck: vi.fn() }));

const PROJECT_ID = 'p1';
const git = hasGit();

let repo: ReturnType<typeof initGitRepo>;

beforeEach(async () => {
  if (!git) return;
  vi.clearAllMocks();
  repo = initGitRepo({ 'README.md': '# app\n' });
  userData.writeData('projects.json', [
    {
      id: PROJECT_ID,
      name: 'App',
      folderPath: repo.dir,
      cliId: 'claude',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  await loadIpc(
    () => import('./git'),
    (module) => module.registerGitHandlers(),
  );
});

const workspaceState = () => invoke<WorkspaceGitState>(IPC.git.workspaceState, PROJECT_ID);

/** The last state pushed to `win` for the project, once one arrives. */
async function pushedState(win: FakeBrowserWindow): Promise<WorkspaceGitState> {
  return vi.waitFor(() => {
    const sent = win.webContents.sentOn(IPC.git.onWorkspaceState);
    const last = sent.at(-1) as [string, WorkspaceGitState] | undefined;
    if (!last) throw new Error('No workspace state was pushed yet.');
    expect(last[0]).toBe(PROJECT_ID);
    return last[1];
  });
}

describe.runIf(git)('tags and the workspace state', () => {
  it('pushes a new tags signature after "Create tag", with HEAD unchanged', async () => {
    const before = await workspaceState();
    const win = new FakeBrowserWindow();

    const result = await invoke<GitOpResult>(IPC.git.createTag, {
      projectId: PROJECT_ID,
      tag: 'v1.2.0',
      push: false,
    });
    expect(result).toMatchObject({ ok: true, message: 'Created tag v1.2.0 locally.' });

    const pushed = await pushedState(win);
    expect(pushed.head).toBe(before.head);
    expect(pushed.tagsSignature).not.toBe(before.tagsSignature);
    expect(pushed.tagsSignature).toBe((await workspaceState()).tagsSignature);
  });

  it('pushes a new tags signature after a tag is deleted', async () => {
    repo.git('tag', 'v1.2.0');
    const tagged = await workspaceState();
    expect(tagged.tagsSignature).not.toBe('');
    const win = new FakeBrowserWindow();

    const { deleteProjectTag } = await import('./git');
    expect(await deleteProjectTag(PROJECT_ID, 'v1.2.0', false)).toMatchObject({ ok: true });

    expect((await pushedState(win)).tagsSignature).toBe('');
  });
});
