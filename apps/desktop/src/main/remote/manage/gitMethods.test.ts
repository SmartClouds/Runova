import { describe, expect, it, vi } from 'vitest';
import type { GitOpResult, WorkspaceGitState } from '../../../shared/apiTypes';
import {
  gitMethods,
  type ManageGitDeps,
  nextVersions,
  parseUnifiedDiff,
  tagChannels,
  untrackedLines,
} from './gitMethods';
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

const FILE_CHANGE = {
  path: 'package.json',
  kind: 'modified' as const,
  beforeId: 'a',
  afterId: 'b',
  beforeRawId: 'ra',
  afterRawId: 'rb',
  additions: 1,
  deletions: 1,
  diff: '',
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
    tags: async () => ({
      latestTag: 'web-v1.4.2',
      recentTags: ['web-v1.4.2', 'web-v1.4.1'],
      commitsSinceLatestTag: 3,
      hasRemote: true,
      prefixes: ['web-v'],
    }),
    suggestTag: async () => ({
      ok: true,
      tag: 'web-v1.5.0',
      reason: 'New feature',
      message: 'Notes',
      cliName: 'Claude Code',
    }),
    createTag: async () => done,
    deleteTag: async () => done,
    suggestCommitMessage: async () => ({ ok: true, text: 'fix: a thing', cliName: 'Codex' }),
    suggestBranchName: async () => ({ ok: true, text: 'fix/a-thing', cliName: 'Codex' }),
    resolveWithAi: async () => ({ ok: true, message: 'Resolved.', summary: 'Kept both' }),
    cancelAi: () => true,
    prStatus: async () =>
      ({
        cliAvailable: true,
        authenticated: true,
        github: { owner: 'a', repo: 'b' },
        branch: 'x',
        defaultBranch: 'main',
        onDefaultBranch: false,
        ahead: 1,
        hasUpstream: true,
        dirty: false,
        pr: {
          number: 12,
          title: 'T',
          url: 'u',
          state: 'OPEN',
          isDraft: false,
          base: 'main',
          head: 'x',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          reviewDecision: 'APPROVED',
          additions: 1,
          deletions: 2,
          checks: [],
          threads: [
            { id: 't', isResolved: false, isOutdated: false, path: 'a', line: 1, comments: [] },
          ],
        },
      }) as never,
    suggestPrText: async () => ({ ok: true, title: 'T', body: 'B', cliName: 'Codex' }),
    createPr: vi.fn(async () => ({ ok: true, url: 'u' })),
    reviewPr: async () => ({ ok: true, text: 'Fine', cliName: 'Codex' }),
    prComment: vi.fn(async () => ({ ok: true })),
    applyVersion: vi.fn(async (_input, onLines) => {
      onLines(['Reading']);
      return { ok: true, output: '', changes: [FILE_CHANGE] };
    }),
    cancelVersion: () => true,
    swapVersionFile: vi.fn(async () => done),
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

describe('tags and AI on a phone', () => {
  it('offers the next version of each size, keeping the prefix', async () => {
    await expect(call(git(), 'git.tags', { projectId: 'p1' })).resolves.toMatchObject({
      latest: 'web-v1.4.2',
      commitsSince: 3,
      channels: [
        {
          channel: 'stable',
          options: [
            { kind: 'patch', tag: 'web-v1.4.3' },
            { kind: 'minor', tag: 'web-v1.5.0' },
            { kind: 'major', tag: 'web-v2.0.0' },
          ],
        },
        {
          channel: 'beta',
          options: [
            { kind: 'patch', tag: 'web-v1.4.3-beta.1' },
            { kind: 'minor', tag: 'web-v1.5.0-beta.1' },
            { kind: 'major', tag: 'web-v2.0.0-beta.1' },
          ],
        },
        {
          channel: 'preview',
          options: [
            { kind: 'patch', tag: 'web-v1.4.3-preview.1' },
            { kind: 'minor', tag: 'web-v1.5.0-preview.1' },
            { kind: 'major', tag: 'web-v2.0.0-preview.1' },
          ],
        },
      ],
    });
  });

  it('starts a repository with no tags at the beginning', () => {
    expect(nextVersions(null)).toEqual({ patch: 'v0.0.1', minor: 'v0.1.0', major: 'v1.0.0' });
  });

  it('finishes a pre-release instead of skipping past it', () => {
    expect(nextVersions('v2.0.0-beta.3')).toEqual({
      patch: 'v2.0.0',
      minor: 'v2.0.0',
      major: 'v2.0.0',
    });
  });

  it('passes a tag on and refuses one with no decision about pushing', async () => {
    const createTag = vi.fn(async () => ({ ok: true, message: 'Created.' }));
    await call(git({ createTag }), 'git.createTag', {
      projectId: 'p1',
      tag: 'v1.0.0',
      message: 'Notes',
      push: true,
    });
    expect(createTag).toHaveBeenCalledWith({
      projectId: 'p1',
      tag: 'v1.0.0',
      message: 'Notes',
      push: true,
    });
    await expect(
      call(git({ createTag }), 'git.createTag', { projectId: 'p1', tag: 'v1' }),
    ).rejects.toThrow('Push it');
  });

  it('runs a suggestion on the computer and sends the answer back', async () => {
    await expect(
      call(git(), 'git.suggestCommitMessage', {
        projectId: 'p1',
        requestId: 'r1',
        scope: 'staged',
      }),
    ).resolves.toMatchObject({
      ok: true,
      text: 'fix: a thing',
      cliName: 'Codex',
      cancelled: false,
    });
  });

  it('turns down a scope it does not know', async () => {
    await expect(
      call(git(), 'git.suggestCommitMessage', {
        projectId: 'p1',
        requestId: 'r1',
        scope: 'everything',
      }),
    ).rejects.toThrow('scope');
  });

  it('never sends an undo token to the phone', async () => {
    const result = await call(
      git({
        resolveWithAi: async () => ({
          ok: true,
          message: 'Resolved.',
          summary: 'Kept both',
          undoToken: 'secret',
        }),
      }),
      'git.resolveWithAi',
      { projectId: 'p1', path: 'a.ts', requestId: 'r1' },
    );
    expect(result).toEqual({
      ok: true,
      message: 'Resolved.',
      summary: 'Kept both',
      cancelled: false,
    });
  });

  it('deletes a tag only once told whether the remote goes too', async () => {
    const deleteTag = vi.fn(async () => ({ ok: true, message: 'Deleted.' }));
    await call(git({ deleteTag }), 'git.deleteTag', {
      projectId: 'p1',
      tag: 'v1.0.0',
      remote: true,
    });
    expect(deleteTag).toHaveBeenCalledWith('p1', 'v1.0.0', true);
    await expect(
      call(git({ deleteTag }), 'git.deleteTag', { projectId: 'p1', tag: 'v1.0.0' }),
    ).rejects.toThrow('there too');
  });

  it('counts past the pre-releases already tagged', () => {
    const channels = tagChannels('v1.4.2', ['v1.4.3-beta.1', 'v1.4.3-beta.2']);
    expect(channels[1]?.options[0]).toEqual({ kind: 'patch', tag: 'v1.4.3-beta.3' });
  });

  it('stops a suggestion by its request', async () => {
    const cancelAi = vi.fn(() => true);
    await expect(call(git({ cancelAi }), 'git.cancelAi', { requestId: 'r1' })).resolves.toEqual({
      cancelled: true,
    });
    expect(cancelAi).toHaveBeenCalledWith('r1');
  });
});

describe('pull requests and version updates on a phone', () => {
  it('sums up a pull request without its threads', async () => {
    const status = (await call(git(), 'git.pr', { projectId: 'p1' })) as {
      repo: string;
      pr: Record<string, unknown>;
    };
    expect(status.repo).toBe('a/b');
    expect(status.pr).toMatchObject({
      number: 12,
      review: 'APPROVED',
      unresolved: 1,
      checksTotal: 0,
    });
    expect(status.pr.threads).toBeUndefined();
  });

  it('opens a pull request with what it was given', async () => {
    const createPr = vi.fn(async () => ({ ok: true, url: 'u' }));
    await call(git({ createPr }), 'git.createPr', {
      projectId: 'p1',
      title: 'T',
      body: 'B',
      base: 'main',
      draft: true,
    });
    expect(createPr).toHaveBeenCalledWith({
      projectId: 'p1',
      title: 'T',
      body: 'B',
      base: 'main',
      draft: true,
    });
  });

  it('runs the version update in the background and keeps the result', async () => {
    const deps = git();
    const methods = gitMethods(deps);
    const invoke = (name: string, params: unknown) =>
      (methods[name] as (p: unknown) => Promise<never>)(params);
    await expect(
      invoke('git.applyVersion', { projectId: 'p1', tag: 'v1', requestId: 'r1' }),
    ).resolves.toEqual({ ok: true });
    await vi.waitFor(async () => {
      const run = (await invoke('git.versionRun', { requestId: 'r1' })) as {
        status: string;
        lines: string[];
        changes: unknown[];
      };
      expect(run.status).toBe('done');
      expect(run.lines).toEqual(['Reading']);
      expect(run.changes).toEqual([
        { path: 'package.json', kind: 'modified', additions: 1, deletions: 1, kept: true },
      ]);
    });
  });

  it('puts a file back and brings it back again', async () => {
    const swapVersionFile = vi.fn(async () => ({ ok: true, message: 'Done' }));
    const methods = gitMethods(git({ swapVersionFile }));
    const invoke = (name: string, params: unknown) =>
      (methods[name] as (p: unknown) => Promise<never>)(params);
    await invoke('git.applyVersion', { projectId: 'p1', tag: 'v1', requestId: 'r2' });
    await vi.waitFor(async () => {
      expect(
        ((await invoke('git.versionRun', { requestId: 'r2' })) as { status: string }).status,
      ).toBe('done');
    });

    await invoke('git.versionToggle', { requestId: 'r2', path: 'package.json' });
    expect(swapVersionFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ fromId: 'b', toId: 'a', toRawId: 'ra' }),
    );
    await invoke('git.versionToggle', { requestId: 'r2', path: 'package.json' });
    expect(swapVersionFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ fromId: 'a', toId: 'b', toRawId: 'rb' }),
    );
  });

  it('only touches files that were part of the run', async () => {
    const methods = gitMethods(git());
    const invoke = (name: string, params: unknown) =>
      (methods[name] as (p: unknown) => Promise<never>)(params);
    await invoke('git.applyVersion', { projectId: 'p1', tag: 'v1', requestId: 'r3' });
    await expect(
      invoke('git.versionToggle', { requestId: 'r3', path: '../secret' }),
    ).rejects.toThrow('not part');
  });
});
