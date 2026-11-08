import { describe, expect, it, vi } from 'vitest';
import type { GitOpResult, WorkspaceGitState } from '../../../shared/apiTypes';
import { gitMethods, type ManageGitDeps, parseUnifiedDiff, untrackedLines } from './gitMethods';
import { ManageError } from './session';

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['git' as const] } };
const done: GitOpResult = { ok: true, message: 'Done.' };

const state: WorkspaceGitState = {
  isRepo: true,
  branch: 'master',
  detached: false,
  head: 'abc1234',
  upstream: 'origin/master',
  ahead: 1,
  behind: 2,
  hasRemote: true,
  operation: null,
  conflicts: [],
  staged: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1 }],
  unstaged: [],
  untracked: [],
  untrackedTruncated: false,
  projectPrefix: 'apps/web',
};

function git(change: Partial<ManageGitDeps> = {}): ManageGitDeps {
  return {
    state: async () => state,
    diff: async () => ({ binary: false, tooLarge: false, raw: '', untracked: null }),
    branches: async () => [],
    stashes: async () => [],
    stage: async () => done,
    unstage: async () => done,
    discard: async () => done,
    commit: async () => done,
    fetch: async () => done,
    pull: async () => done,
    push: async () => done,
    checkout: async () => done,
    createBranch: async () => done,
    deleteBranch: async () => done,
    stashPush: async () => done,
    stashPop: async () => done,
    stashDrop: async () => done,
    resolve: async () => done,
    abort: async () => done,
    ...change,
  };
}

function call(deps: ManageGitDeps, method: string, params: unknown) {
  return gitMethods(deps)[method](params, context);
}

describe('parseUnifiedDiff', () => {
  const raw = [
    'diff --git a/a.ts b/a.ts',
    'index 111..222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@ function top',
    ' same',
    '-old',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('keeps the hunks and leaves out the file headers', () => {
    expect(parseUnifiedDiff(raw)).toEqual({
      tooLarge: false,
      lines: [
        { kind: 'hunk', text: '@@ -1,2 +1,2 @@ function top' },
        { kind: 'ctx', text: 'same' },
        { kind: 'del', text: 'old' },
        { kind: 'add', text: 'new' },
      ],
    });
  });

  it('does not mistake changed lines that look like headers for headers', () => {
    const tricky = ['@@ -1 +1 @@', '---- a comment', '++++ more'].join('\n');

    expect(parseUnifiedDiff(tricky).lines).toEqual([
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'del', text: '--- a comment' },
      { kind: 'add', text: '+++ more' },
    ]);
  });

  it('gives up on too many lines rather than filling a phone', () => {
    const long = ['@@ -1 +1 @@', ...Array.from({ length: 5000 }, () => '+x')].join('\n');

    expect(parseUnifiedDiff(long)).toEqual({ tooLarge: true, lines: [] });
  });

  it('gives up on a few enormous lines too', () => {
    const wide = ['@@ -1 +1 @@', `+${'x'.repeat(400 * 1024)}`].join('\n');

    expect(parseUnifiedDiff(wide)).toEqual({ tooLarge: true, lines: [] });
  });
});

describe('untrackedLines', () => {
  it('shows a new file as all added', () => {
    expect(untrackedLines('one\ntwo\n').lines).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
  });
});

describe('git methods', () => {
  it('shows the state without where the project sits on the computer', async () => {
    const result = (await call(git(), 'git.state', { projectId: 'p1' })) as Record<string, unknown>;

    expect(result.branch).toBe('master');
    expect(result.ahead).toBe(1);
    expect(result).not.toHaveProperty('projectPrefix');
    expect(result).not.toHaveProperty('head');
  });

  it('needs a project', async () => {
    await expect(call(git(), 'git.state', {})).rejects.toBeInstanceOf(ManageError);
  });

  it('turns a diff into lines for the phone', async () => {
    const deps = git({
      diff: async () => ({
        binary: false,
        tooLarge: false,
        raw: '@@ -1 +1 @@\n-a\n+b\n',
        untracked: null,
      }),
    });

    const result = await call(deps, 'git.diff', {
      projectId: 'p1',
      path: 'a.ts',
      side: 'unstaged',
    });

    expect(result).toEqual({
      path: 'a.ts',
      binary: false,
      tooLarge: false,
      lines: [
        { kind: 'hunk', text: '@@ -1 +1 @@' },
        { kind: 'del', text: 'a' },
        { kind: 'add', text: 'b' },
      ],
    });
  });

  it('says a file is too large instead of sending it', async () => {
    const deps = git({
      diff: async () => ({ binary: false, tooLarge: true, raw: '', untracked: null }),
    });

    const result = await call(deps, 'git.diff', { projectId: 'p1', path: 'a', side: 'staged' });

    expect(result).toEqual({ path: 'a', binary: false, tooLarge: true, lines: [] });
  });

  it('refuses a side it does not know', async () => {
    await expect(
      call(git(), 'git.diff', { projectId: 'p1', path: 'a', side: 'conflict' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('passes what to stage along', async () => {
    const stage = vi.fn(async () => done);

    await call(git({ stage }), 'git.stage', { projectId: 'p1', paths: ['a.ts', 'b.ts'] });

    expect(stage).toHaveBeenCalledWith('p1', ['a.ts', 'b.ts']);
  });

  it('refuses paths that are not a list of names', async () => {
    await expect(
      call(git(), 'git.stage', { projectId: 'p1', paths: ['a', 1] }),
    ).rejects.toBeInstanceOf(ManageError);
    await expect(call(git(), 'git.stage', { projectId: 'p1', paths: [] })).rejects.toBeInstanceOf(
      ManageError,
    );
  });

  it('commits and pushes when asked', async () => {
    const commit = vi.fn(async () => done);

    await call(git({ commit }), 'git.commit', { projectId: 'p1', message: 'Fix', push: true });

    expect(commit).toHaveBeenCalledWith('p1', 'Fix', true);
  });

  it('does not accept an empty commit message', async () => {
    await expect(
      call(git(), 'git.commit', { projectId: 'p1', message: '   ' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('hands back why git refused', async () => {
    const push = async () => ({ ok: false, message: 'rejected: non-fast-forward' });

    await expect(call(git({ push }), 'git.push', { projectId: 'p1' })).resolves.toEqual({
      ok: false,
      message: 'rejected: non-fast-forward',
    });
  });

  it('discards only from a side it knows', async () => {
    const discard = vi.fn(async () => done);

    await call(git({ discard }), 'git.discard', {
      projectId: 'p1',
      paths: ['a'],
      side: 'untracked',
    });

    expect(discard).toHaveBeenCalledWith('p1', ['a'], 'untracked');
    await expect(
      call(git({ discard }), 'git.discard', { projectId: 'p1', paths: ['a'], side: 'staged' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('keeps one side of a conflict', async () => {
    const resolve = vi.fn(async () => done);

    await call(git({ resolve }), 'git.resolve', { projectId: 'p1', path: 'a', pick: 'theirs' });

    expect(resolve).toHaveBeenCalledWith('p1', 'a', 'theirs');
    await expect(
      call(git({ resolve }), 'git.resolve', { projectId: 'p1', path: 'a', pick: 'both' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('checks out, creates and deletes branches by name', async () => {
    const checkout = vi.fn(async () => done);
    const createBranch = vi.fn(async () => done);
    const deleteBranch = vi.fn(async () => done);
    const deps = git({ checkout, createBranch, deleteBranch });

    await call(deps, 'git.checkout', { projectId: 'p1', name: 'dev' });
    await call(deps, 'git.createBranch', { projectId: 'p1', name: 'new' });
    await call(deps, 'git.deleteBranch', { projectId: 'p1', name: 'old' });

    expect(checkout).toHaveBeenCalledWith('p1', 'dev');
    expect(createBranch).toHaveBeenCalledWith('p1', 'new');
    expect(deleteBranch).toHaveBeenCalledWith('p1', 'old');
  });

  it('stashes with an optional message', async () => {
    const stashPush = vi.fn(async () => done);

    await call(git({ stashPush }), 'git.stashPush', { projectId: 'p1' });

    expect(stashPush).toHaveBeenCalledWith('p1', undefined);
  });

  it('pops and drops a stash by its reference', async () => {
    const stashPop = vi.fn(async () => done);
    const stashDrop = vi.fn(async () => done);

    await call(git({ stashPop }), 'git.stashPop', { projectId: 'p1', ref: 'stash@{1}' });
    await call(git({ stashDrop }), 'git.stashDrop', { projectId: 'p1', ref: 'stash@{0}' });

    expect(stashPop).toHaveBeenCalledWith('p1', 'stash@{1}');
    expect(stashDrop).toHaveBeenCalledWith('p1', 'stash@{0}');
  });

  it('runs every method the protocol names for git', async () => {
    const { MANAGE_METHODS } = await import('@runova/protocol');
    const named = Object.keys(MANAGE_METHODS).filter((name) => name.startsWith('git.'));

    expect(Object.keys(gitMethods(git())).sort()).toEqual(named.sort());
  });
});
