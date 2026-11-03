import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkspaceGitState } from '../../../shared/apiTypes';
import {
  checkoutBranch,
  createBranch,
  currentBranch,
  deleteBranch,
  git,
  gitOrNull,
  listBranches,
  pushCurrentBranch,
} from '../../git/plumbing';
import {
  assertRepoPaths,
  commitStaged,
  discardPaths,
  locateRepo,
  readWorkspaceGitState,
  stagePaths,
  unstagePaths,
} from '../../git/workspaceGit';
import {
  createWorktree,
  listProjectWorktrees,
  mergeWorktree,
  removeProjectWorktree,
} from '../../worktrees/service';
import { defineTool, type ToolContext } from '../registry';
import { plural, projectIdArg, projectIdOf, projectOf } from './shared';

/**
 * Git and worktree tools: what the Workspace git panel and the Worktrees view do, for an agent.
 * They run in the project's folder through the same helpers as the app. Anything that loses work
 * or reaches the remote is sensitive.
 */

const MAX_DIFF = 40_000;

async function repoOf(context: ToolContext): Promise<{ root: string; folder: string }> {
  const project = await projectOf(context);
  const repo = await locateRepo(project.folderPath);
  if (!repo) throw new Error(`${project.name} is not a git repository.`);
  return { root: repo.root, folder: project.folderPath };
}

function changes(state: WorkspaceGitState) {
  const shape = (list: WorkspaceGitState['staged']) =>
    list.map((one) => ({ path: one.path, status: one.status, from: one.origPath }));
  return {
    staged: shape(state.staged),
    unstaged: shape(state.unstaged),
    untracked: shape(state.untracked),
    conflicts: shape(state.conflicts),
  };
}

const pathsArg = z
  .array(z.string().min(1))
  .min(1)
  .max(500)
  .describe('Paths relative to the repository root.');

export const gitTools = [
  defineTool({
    name: 'git_status',
    area: 'git',
    title: 'Git status',
    description:
      'The branch, how far it is ahead of or behind its upstream, and the staged, unstaged, untracked and conflicted files.',
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Read the git status' }),
    async run(_args, context) {
      const { folder } = await repoOf(context);
      const state = await readWorkspaceGitState(folder);
      return {
        data: {
          branch: state.branch,
          detached: state.detached,
          upstream: state.upstream,
          ahead: state.ahead,
          behind: state.behind,
          operation: state.operation,
          ...changes(state),
        },
      };
    },
  }),

  defineTool({
    name: 'git_diff',
    area: 'git',
    title: 'Git diff',
    description:
      'The unified diff of the working tree, or of what is staged with staged: true, for all files or the given paths.',
    risk: 'read',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      staged: z.boolean().optional(),
      paths: pathsArg.optional(),
    }),
    preview: (args) => ({ title: `Read the ${args.staged ? 'staged' : 'working tree'} diff` }),
    async run(args, context) {
      const { root } = await repoOf(context);
      const paths = args.paths ? assertRepoPaths(root, args.paths) : [];
      const diff = await git(root, ['diff', ...(args.staged ? ['--cached'] : []), '--', ...paths]);
      if (!diff.trim())
        return { text: args.staged ? 'No staged changes.' : 'No unstaged changes.' };
      return {
        text:
          diff.length > MAX_DIFF
            ? `${diff.slice(0, MAX_DIFF)}\n\n(The diff is longer; ask for fewer paths to see the rest.)`
            : diff,
      };
    },
  }),

  defineTool({
    name: 'git_log',
    area: 'git',
    title: 'Git log',
    description:
      'The latest commits on the current branch or another one: hash, author, date and subject.',
    risk: 'read',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      limit: z.number().int().min(1).max(200).optional(),
      branch: z.string().optional(),
    }),
    preview: () => ({ title: 'Read the commit history' }),
    async run(args, context) {
      const { root } = await repoOf(context);
      const output = await git(root, [
        'log',
        `-n${args.limit ?? 20}`,
        '--format=%h%x1f%an%x1f%aI%x1f%s',
        ...(args.branch ? [args.branch, '--'] : []),
      ]);
      return {
        data: output
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [hash, author, date, subject] = line.split('\x1f');
            return { hash, author, date, subject };
          }),
      };
    },
  }),

  defineTool({
    name: 'git_branches',
    area: 'git',
    title: 'List git branches',
    description:
      'Local and remote branches, which one is checked out, and which are open in another worktree.',
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'List the branches' }),
    async run(_args, context) {
      const { root } = await repoOf(context);
      const current = await currentBranch(root).catch(() => '');
      const branches = await listBranches(root);
      return {
        data: branches.map((branch) => ({
          name: branch.name,
          current: branch.name === current,
          local: branch.local,
          remote: branch.remote,
          inWorktree: branch.worktreePath ?? null,
        })),
      };
    },
  }),

  defineTool({
    name: 'git_stage',
    area: 'git',
    title: 'Stage files',
    description:
      'Stages the given paths (new, changed or deleted files), or unstages them with unstage: true.',
    risk: 'write',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, paths: pathsArg, unstage: z.boolean().optional() }),
    preview: (args) => ({
      title: `${args.unstage ? 'Unstage' : 'Stage'} ${plural(args.paths.length, 'file')}`,
      fields: [{ label: 'Files', value: args.paths.join('\n'), mono: true }],
    }),
    async run(args, context) {
      const { root } = await repoOf(context);
      const paths = assertRepoPaths(root, args.paths);
      if (args.unstage) await unstagePaths(root, paths);
      else await stagePaths(root, paths);
      return { text: `${args.unstage ? 'Unstaged' : 'Staged'} ${plural(paths.length, 'file')}.` };
    },
  }),

  defineTool({
    name: 'git_commit',
    area: 'git',
    title: 'Commit',
    description: 'Commits what is staged with the given message. Stage files with git_stage first.',
    risk: 'write',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, message: z.string().min(1).max(10_000) }),
    async preview(args, context) {
      const { root } = await repoOf(context);
      const staged = ((await gitOrNull(root, ['diff', '--cached', '--name-only'])) ?? '')
        .split('\n')
        .filter(Boolean);
      return {
        title: 'Commit the staged changes',
        fields: [
          { label: 'Message', value: args.message },
          { label: 'Files', value: staged.join('\n') || 'Nothing is staged', mono: true },
        ],
      };
    },
    async run(args, context) {
      const { root } = await repoOf(context);
      const output = await commitStaged(root, args.message);
      return { text: output.trim() || 'Committed.' };
    },
  }),

  defineTool({
    name: 'git_create_branch',
    area: 'git',
    title: 'Create a branch',
    description: 'Creates a branch from the current commit and checks it out.',
    risk: 'write',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, name: z.string().min(1).max(200) }),
    preview: (args) => ({ title: `Create and check out ${args.name}` }),
    async run(args, context) {
      const { root } = await repoOf(context);
      await createBranch(root, args.name);
      return { text: `Created and checked out ${await currentBranch(root)}.` };
    },
  }),

  defineTool({
    name: 'git_checkout',
    area: 'git',
    title: 'Check out a branch',
    description:
      'Switches the working tree to another branch. Git refuses when local changes would be lost.',
    risk: 'write',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, branch: z.string().min(1).max(200) }),
    preview: (args) => ({ title: `Check out ${args.branch}` }),
    async run(args, context) {
      const { root } = await repoOf(context);
      await checkoutBranch(root, args.branch);
      return { text: `Checked out ${args.branch}.` };
    },
  }),

  defineTool({
    name: 'git_push',
    area: 'git',
    title: 'Push',
    description: 'Pushes the current branch to its remote, setting the upstream when it has none.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    async preview(_args, context) {
      const { root } = await repoOf(context);
      const branch = await currentBranch(root);
      const ahead = (await gitOrNull(root, ['rev-list', '--count', '@{upstream}..HEAD']))?.trim();
      return {
        title: `Push ${branch}`,
        fields: [
          { label: 'Branch', value: branch, mono: true },
          { label: 'Commits to push', value: ahead ?? 'All of them (no upstream yet)' },
        ],
      };
    },
    async run(_args, context) {
      const { root } = await repoOf(context);
      const branch = await currentBranch(root);
      const output = await pushCurrentBranch(root, branch);
      return { text: output.trim() || `Pushed ${branch}.` };
    },
  }),

  defineTool({
    name: 'git_discard',
    area: 'git',
    title: 'Discard changes',
    description:
      'Throws away unstaged changes to the given tracked files, putting back what is staged or committed. Runova keeps a backup the user can undo from the git panel.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, paths: pathsArg }),
    async preview(args, context) {
      const { root } = await repoOf(context);
      const paths = assertRepoPaths(root, args.paths);
      const [first] = paths;
      const before = await readFile(join(root, first), 'utf-8').catch(() => '');
      const after = (await gitOrNull(root, ['show', `:${first}`])) ?? '';
      return {
        title: `Throw away changes to ${plural(paths.length, 'file')}`,
        fields:
          paths.length > 1 ? [{ label: 'Files', value: paths.join('\n'), mono: true }] : undefined,
        diff: { fileName: first, before, after },
      };
    },
    async run(args, context) {
      const { root } = await repoOf(context);
      const paths = assertRepoPaths(root, args.paths);
      await discardPaths(root, paths, 'unstaged');
      return { text: `Threw away the changes to ${plural(paths.length, 'file')}.` };
    },
  }),

  defineTool({
    name: 'git_delete_branch',
    area: 'git',
    title: 'Delete a branch',
    description:
      'Deletes a local branch, and its remote copy with deleteRemote. Git refuses an unmerged branch unless force is true.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      name: z.string().min(1).max(200),
      deleteRemote: z.boolean().optional(),
      force: z.boolean().optional(),
    }),
    preview: (args) => ({
      title: `Delete the branch ${args.name}`,
      fields: [
        { label: 'Also on the remote', value: args.deleteRemote ? 'Yes' : 'No' },
        { label: 'Even if not merged', value: args.force ? 'Yes' : 'No' },
      ],
    }),
    async run(args, context) {
      const { root } = await repoOf(context);
      const output = await deleteBranch(root, args.name, {
        deleteRemote: args.deleteRemote === true,
        force: args.force === true,
      });
      return { text: output.trim() || `Deleted ${args.name}.` };
    },
  }),

  defineTool({
    name: 'worktrees_list',
    area: 'worktrees',
    title: 'List worktrees',
    description: "The project's git worktrees with their branch, base branch, folder and status.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'List the worktrees' }),
    async run(_args, context) {
      const worktrees = await listProjectWorktrees(projectIdOf(context));
      return {
        data: worktrees.map((one) => ({
          id: one.id,
          branch: one.branch,
          baseBranch: one.baseBranch,
          path: one.path,
          missing: one.missing,
          status: one.status,
        })),
      };
    },
  }),

  defineTool({
    name: 'worktree_create',
    area: 'worktrees',
    title: 'Create a worktree',
    description:
      'Creates a worktree on a new branch (from base, or the default branch) or on an existing branch with existing: true.',
    risk: 'write',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      branch: z.string().min(1).max(200),
      existing: z.boolean().optional(),
      base: z.string().optional(),
    }),
    preview: (args) => ({
      title: `Create a worktree for ${args.branch}`,
      fields: args.base ? [{ label: 'From', value: args.base, mono: true }] : undefined,
    }),
    async run(args, context) {
      const worktree = await createWorktree({
        projectId: projectIdOf(context),
        branch: args.branch,
        mode: args.existing ? 'existing' : 'new',
        base: args.base ?? null,
        path: null,
      });
      return {
        text: `Created a worktree for ${worktree.branch} at ${worktree.path} (id ${worktree.id}).`,
      };
    },
  }),

  defineTool({
    name: 'worktree_remove',
    area: 'worktrees',
    title: 'Remove a worktree',
    description:
      'Removes a worktree folder. force also throws away its uncommitted changes, deleteBranch deletes its branch.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      worktreeId: z.string().min(1).describe('From worktrees_list.'),
      force: z.boolean().optional(),
      deleteBranch: z.boolean().optional(),
    }),
    async preview(args, context) {
      const worktree = (await listProjectWorktrees(projectIdOf(context))).find(
        (one) => one.id === args.worktreeId,
      );
      return {
        title: `Remove the worktree ${worktree?.branch ?? args.worktreeId}`,
        fields: [
          { label: 'Folder', value: worktree?.path ?? 'unknown', mono: true },
          { label: 'Throw away uncommitted changes', value: args.force ? 'Yes' : 'No' },
          { label: 'Delete the branch', value: args.deleteBranch ? 'Yes' : 'No' },
        ],
      };
    },
    async run(args, context) {
      const output = await removeProjectWorktree({
        projectId: projectIdOf(context),
        worktreeId: args.worktreeId,
        force: args.force === true,
        deleteBranch: args.deleteBranch === true,
      });
      return { text: output.trim() || 'Removed the worktree.' };
    },
  }),

  defineTool({
    name: 'worktree_merge',
    area: 'worktrees',
    title: 'Merge a worktree back',
    description:
      "Merges a worktree's branch into the branch it was made from, after the same checks as the app.",
    risk: 'sensitive',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, worktreeId: z.string().min(1) }),
    async preview(args, context) {
      const worktree = (await listProjectWorktrees(projectIdOf(context))).find(
        (one) => one.id === args.worktreeId,
      );
      return {
        title: `Merge ${worktree?.branch ?? 'the worktree'} into ${worktree?.baseBranch ?? 'its base'}`,
      };
    },
    async run(args, context) {
      const result = await mergeWorktree(projectIdOf(context), args.worktreeId);
      return { data: result };
    },
  }),
];
