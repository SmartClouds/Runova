import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  readStatus,
  git as runGit,
  runGitOp,
} from '../../git/plumbing';
import {
  abortOperation,
  assertRepoPaths,
  listStashes,
  readFileDiff,
  readWorkspaceGitState,
  resolveConflict,
  stagePaths,
  stashDrop,
  stashPush,
  stashRestore,
  unstagePaths,
} from '../../git/workspaceGit';
import {
  commitStagedChanges,
  discardChanges,
  getProjectPath,
  pushProject,
  requireRepo,
  workspaceGitOp,
} from '../../ipc/git';
import type { ManageGitDeps } from './gitMethods';

/** The same git the desktop's changes panel runs. */
export const liveGit: ManageGitDeps = {
  state: async (projectId) => readWorkspaceGitState(await getProjectPath(projectId)),
  diff: async (projectId, path, side, origPath) => {
    const { root } = await requireRepo(projectId);
    const [safe] = assertRepoPaths(root, [path]);
    const [orig] = origPath ? assertRepoPaths(root, [origPath]) : [undefined];
    const file = await readFileDiff(root, safe, side, orig);
    if (file.binary || file.tooLarge) {
      return { binary: file.binary, tooLarge: file.tooLarge, raw: '', untracked: null };
    }
    if (side === 'untracked') {
      return { binary: false, tooLarge: false, raw: '', untracked: file.modified };
    }
    const raw = await runGit(root, [
      '--literal-pathspecs',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-M',
      ...(side === 'staged' ? ['--cached'] : []),
      '--',
      ...(orig ? [orig] : []),
      safe,
    ]);
    return { binary: false, tooLarge: false, raw, untracked: null };
  },
  branches: async (projectId) => {
    const status = await readStatus(await getProjectPath(projectId));
    return status.branches.map((branch) => ({
      name: branch.name,
      current: branch.name === status.branch,
      local: branch.local,
    }));
  },
  stashes: async (projectId) => {
    const { root } = await requireRepo(projectId);
    return (await listStashes(root)).map(({ ref, message }) => ({ ref, message }));
  },
  stage: (projectId, paths) =>
    workspaceGitOp(projectId, async ({ root }) => {
      await stagePaths(root, assertRepoPaths(root, paths));
      return 'Staged.';
    }),
  unstage: (projectId, paths) =>
    workspaceGitOp(projectId, async ({ root }) => {
      await unstagePaths(root, assertRepoPaths(root, paths));
      return 'Unstaged.';
    }),
  discard: discardChanges,
  commit: commitStagedChanges,
  fetch: async (projectId) => {
    const cwd = await getProjectPath(projectId);
    return runGitOp(() => runGit(cwd, ['fetch', '--all', '--prune']));
  },
  pull: async (projectId) => {
    const cwd = await getProjectPath(projectId);
    return runGitOp(() => runGit(cwd, ['pull']));
  },
  push: pushProject,
  checkout: async (projectId, name) => {
    const cwd = await getProjectPath(projectId);
    return runGitOp(() => checkoutBranch(cwd, name));
  },
  createBranch: async (projectId, name) => {
    const cwd = await getProjectPath(projectId);
    return runGitOp(() => createBranch(cwd, name));
  },
  deleteBranch: async (projectId, name) => {
    const cwd = await getProjectPath(projectId);
    return runGitOp(() => deleteBranch(cwd, name, { deleteRemote: false, force: false }));
  },
  stashPush: (projectId, message) =>
    workspaceGitOp(projectId, ({ root }) =>
      stashPush(root, { includeUntracked: false, keepIndex: false, message }),
    ),
  stashPop: (projectId, ref) =>
    workspaceGitOp(projectId, ({ root }) => stashRestore(root, ref, 'pop')),
  stashDrop: (projectId, ref) => workspaceGitOp(projectId, ({ root }) => stashDrop(root, ref)),
  resolve: (projectId, path, pick) =>
    workspaceGitOp(projectId, async ({ root }) => {
      const [safe] = assertRepoPaths(root, [path]);
      await resolveConflict(root, safe, pick);
      return `Kept ${pick === 'ours' ? 'your' : 'their'} version of ${safe}.`;
    }),
  abort: (projectId) =>
    workspaceGitOp(projectId, ({ root, gitDir }) => abortOperation(root, gitDir)),
};
