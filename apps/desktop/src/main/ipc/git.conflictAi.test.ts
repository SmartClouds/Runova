import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GitOpResult,
  ResolveConflictWithAiResult,
  WorkspaceGitState,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { hasGit, initGitRepo } from '../../test/main/fixtures';
import { invoke, loadIpc, useTempUserData } from '../../test/main/ipcHarness';

/**
 * "Resolve with AI" hands a conflicted file to the project's AI CLI with write access. The CLI is
 * the only thing faked here: it stands in for the agent by editing the file on disk the way a
 * real one would, while git, the backup and the checks run for real against a repository that
 * is stuck in a merge. What these pin down is that the file is only ever left resolved or back
 * exactly as it was, never half edited, and that nothing gets staged behind the user's back.
 */

const userData = useTempUserData();

const headless = vi.hoisted(() => ({
  runHeadlessCliPrompt: vi.fn(),
  cancelHeadlessPrompt: vi.fn(() => true),
}));
vi.mock('../cli/headlessPrompt', () => headless);

vi.mock('../pipelines/watcher', () => ({ schedulePipelineCheck: vi.fn() }));

// The git channels bring most of the main process with them. Vitest keeps the transformed files
// between the hooks' imports, so loading them once here moves the cold transform (slow on the Mac
// runner's disk) out of the first hook's time limit, as in git.clone.test.ts.
await import('./git');

const PROJECT_ID = 'p1';
const FILE = 'src/app.ts';
const RESOLVED = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

const git = hasGit();

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
}

/** A repository mid-merge, with both branches having changed the same line of FILE. */
function conflictedRepo(): Repo {
  const repo = initGitRepo({ [FILE]: 'export const a = 1;\n', 'README.md': '# app\n' });
  repo.git('config', 'core.autocrlf', 'false');
  repo.git('checkout', '-b', 'feature');
  writeFileSync(join(repo.dir, FILE), 'export const a = 1;\nexport const c = 3;\n');
  repo.commitAll('add c');
  repo.git('checkout', 'main');
  writeFileSync(join(repo.dir, FILE), 'export const a = 1;\nexport const b = 2;\n');
  repo.commitAll('add b');
  try {
    repo.git('merge', 'feature');
  } catch {
    // Git exits non-zero when it stops on a conflict, which is the state wanted here.
  }
  return repo;
}

const read = (repo: Repo, path = FILE): string => readFileSync(join(repo.dir, path), 'utf8');

/** Makes the fake CLI edit the file, then answer with `answer`. */
function agentWrites(repo: Repo, content: string, answer: Record<string, unknown> = {}): void {
  headless.runHeadlessCliPrompt.mockImplementation(async () => {
    writeFileSync(join(repo.dir, FILE), content);
    return { ok: true, text: 'Kept both exports.', cliName: 'Claude Code', ...answer };
  });
}

const resolveWithAi = (path = FILE) =>
  invoke<ResolveConflictWithAiResult>(IPC.git.resolveConflictWithAi, PROJECT_ID, path, 'request-1');

const conflicts = async (): Promise<string[]> =>
  (await invoke<WorkspaceGitState>(IPC.git.workspaceState, PROJECT_ID)).conflicts.map(
    (entry) => entry.path,
  );

let repo: Repo;
let before: string;

beforeEach(async () => {
  if (!git) return;
  vi.clearAllMocks();
  repo = conflictedRepo();
  before = read(repo);
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

describe.runIf(git)('resolveConflictWithAi', () => {
  it('starts from a real conflict', () => {
    expect(before).toMatch(/^<<<<<<< HEAD$/m);
    expect(before).toMatch(/^>>>>>>> feature$/m);
  });

  it('lets the CLI write the file and leaves it unstaged for review', async () => {
    agentWrites(repo, RESOLVED);

    const result = await resolveWithAi();

    expect(result).toMatchObject({
      ok: true,
      message: `Claude Code resolved ${FILE}. Review it, then mark it as resolved.`,
      summary: 'Kept both exports.',
    });
    expect(result.undoToken).toEqual(expect.any(String));
    expect(read(repo)).toBe(RESOLVED);
    // Marking it resolved stays the user's call.
    expect(await conflicts()).toEqual([FILE]);
  });

  it('runs the project CLI in the repository with write access and a prompt about the file', async () => {
    agentWrites(repo, RESOLVED);

    await resolveWithAi();

    expect(headless.runHeadlessCliPrompt).toHaveBeenCalledOnce();
    const [prompt, cwd, options] = headless.runHeadlessCliPrompt.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(prompt).toContain(`"${FILE}"`);
    expect(prompt).toContain('A merge is in progress');
    expect(prompt).toContain('both modified');
    expect(readFileSync(join(cwd, FILE), 'utf8')).toBe(RESOLVED);
    expect(options).toMatchObject({
      requestId: 'request-1',
      preferredCliId: 'claude',
      allowWrites: true,
      timeoutMs: 600000,
    });
  });

  it('puts the conflict markers back when the user undoes it', async () => {
    agentWrites(repo, RESOLVED);
    const { undoToken } = await resolveWithAi();

    const undo = await invoke<GitOpResult>(IPC.git.undoDiscard, PROJECT_ID, undoToken);

    expect(undo.ok).toBe(true);
    expect(read(repo)).toBe(before);
  });

  it('restores the file when the CLI leaves conflict markers behind', async () => {
    agentWrites(repo, `${RESOLVED}<<<<<<< HEAD\nleft over\n>>>>>>> feature\n`);

    const result = await resolveWithAi();

    expect(result).toEqual({
      ok: false,
      message: 'Claude Code left conflict markers in the file. The file is back as it was.',
    });
    expect(read(repo)).toBe(before);
  });

  it('restores the file when the CLI deletes it', async () => {
    headless.runHeadlessCliPrompt.mockImplementation(async () => {
      rmSync(join(repo.dir, FILE));
      return { ok: true, text: 'Removed it.', cliName: 'Claude Code' };
    });

    const result = await resolveWithAi();

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Claude Code removed or broke the file. The file is back as it was.',
    );
    expect(read(repo)).toBe(before);
  });

  it('restores the file and stays quiet when the user stops the run', async () => {
    // Stopped half way through its edit.
    agentWrites(repo, 'export const a = 1;\n<<<<<<< HEAD\n', {
      ok: false,
      text: '',
      cancelled: true,
    });

    const result = await resolveWithAi();

    expect(result).toEqual({
      ok: false,
      cancelled: true,
      message: 'Stopped. The file is back as it was.',
    });
    expect(read(repo)).toBe(before);
  });

  it('restores the file when the CLI runs out of time, even if the markers are gone', async () => {
    // A run killed mid-way can't be trusted to have finished the edit it started.
    agentWrites(repo, 'export const a = 1;\n', {
      ok: false,
      text: '',
      timedOut: true,
      error: 'Claude Code was still working after 10 minutes and was stopped.',
    });

    const result = await resolveWithAi();

    expect(result).toEqual({
      ok: false,
      message:
        'Claude Code was still working after 10 minutes and was stopped. The file is back as it was.',
    });
    expect(read(repo)).toBe(before);
  });

  it('keeps an edit that landed even though the CLI ended without an answer', async () => {
    agentWrites(repo, RESOLVED, {
      ok: false,
      text: '',
      error: 'Claude Code returned an empty answer.',
    });

    const result = await resolveWithAi();

    expect(result).toMatchObject({ ok: true, summary: undefined });
    expect(read(repo)).toBe(RESOLVED);
  });

  it("passes the CLI's own error on when it failed without touching the file", async () => {
    headless.runHeadlessCliPrompt.mockResolvedValue({
      ok: false,
      text: '',
      cliName: null,
      error: 'No installed CLI supports non-interactive prompts.',
    });

    const result = await resolveWithAi();

    expect(result).toEqual({
      ok: false,
      message: 'No installed CLI supports non-interactive prompts. The file is back as it was.',
    });
    expect(read(repo)).toBe(before);
  });

  it('refuses a file that is not in conflict, without starting a CLI', async () => {
    const result = await resolveWithAi('README.md');

    expect(result).toEqual({ ok: false, message: 'README.md is no longer in conflict.' });
    expect(headless.runHeadlessCliPrompt).not.toHaveBeenCalled();
  });

  it('refuses a conflicted file whose markers the user already removed', async () => {
    writeFileSync(join(repo.dir, FILE), RESOLVED);

    const result = await resolveWithAi();

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      `${FILE} has no conflict markers left. Review it and mark it as resolved, or keep one side.`,
    );
    expect(headless.runHeadlessCliPrompt).not.toHaveBeenCalled();
  });

  it('refuses a conflicted file that is not text', async () => {
    writeFileSync(join(repo.dir, FILE), Buffer.from([0x3c, 0x3c, 0x00, 0x01]));

    const result = await resolveWithAi();

    expect(result).toEqual({
      ok: false,
      message: `${FILE} is not a text file on disk. Keep ours or theirs instead.`,
    });
    expect(headless.runHeadlessCliPrompt).not.toHaveBeenCalled();
  });

  it('refuses a path outside the repository', async () => {
    const result = await resolveWithAi('../elsewhere.ts');

    expect(result).toEqual({ ok: false, message: 'That path is outside the repository.' });
    expect(headless.runHeadlessCliPrompt).not.toHaveBeenCalled();
  });
});

describe.runIf(git)('cancelResolveConflictWithAi', () => {
  it('stops the CLI run behind the request', async () => {
    const stopped = await invoke<boolean>(IPC.git.cancelResolveConflictWithAi, 'request-1');

    expect(stopped).toBe(true);
    expect(headless.cancelHeadlessPrompt).toHaveBeenCalledWith('request-1');
  });
});
