import { versionOnChannel } from '@runova/core';
import type {
  ManageGitBranch,
  ManageGitDiff,
  ManageGitDiffLine,
  ManageGitStash,
} from '@runova/protocol';
import type {
  CreateTagInput,
  GitOpResult,
  GitTagInfo,
  ResolveConflictWithAiResult,
  SuggestGitTextResult,
  SuggestTagResult,
  WorkspaceGitState,
} from '../../../shared/apiTypes';
import { ManageError, type ManageMethods } from './session';

type Calls = ManageMethods['calls'];
export type GitChangeSide = 'staged' | 'unstaged' | 'untracked';

export interface RawGitDiff {
  binary: boolean;
  tooLarge: boolean;
  /** `git diff` output, for a file git already tracks. */
  raw: string;
  /** The whole text of a new file, which git has nothing to compare with. */
  untracked: string | null;
}

/** What the git methods need from the rest of the app. */
export interface ManageGitDeps {
  state(projectId: string): Promise<WorkspaceGitState>;
  diff(
    projectId: string,
    path: string,
    side: GitChangeSide,
    origPath: string | undefined,
  ): Promise<RawGitDiff>;
  branches(projectId: string): Promise<ManageGitBranch[]>;
  stashes(projectId: string): Promise<ManageGitStash[]>;
  stage(projectId: string, paths: string[]): Promise<GitOpResult>;
  unstage(projectId: string, paths: string[]): Promise<GitOpResult>;
  discard(projectId: string, paths: string[], side: 'unstaged' | 'untracked'): Promise<GitOpResult>;
  commit(projectId: string, message: string, push: boolean): Promise<GitOpResult>;
  fetch(projectId: string): Promise<GitOpResult>;
  pull(projectId: string): Promise<GitOpResult>;
  push(projectId: string): Promise<GitOpResult>;
  checkout(projectId: string, name: string): Promise<GitOpResult>;
  createBranch(projectId: string, name: string): Promise<GitOpResult>;
  deleteBranch(projectId: string, name: string): Promise<GitOpResult>;
  stashPush(projectId: string, message: string | undefined): Promise<GitOpResult>;
  stashPop(projectId: string, ref: string): Promise<GitOpResult>;
  stashDrop(projectId: string, ref: string): Promise<GitOpResult>;
  resolve(projectId: string, path: string, pick: 'ours' | 'theirs'): Promise<GitOpResult>;
  abort(projectId: string): Promise<GitOpResult>;
  tags(projectId: string): Promise<GitTagInfo>;
  suggestTag(projectId: string, requestId: string): Promise<SuggestTagResult>;
  createTag(input: CreateTagInput): Promise<GitOpResult>;
  deleteTag(projectId: string, tag: string, remote: boolean): Promise<GitOpResult>;
  suggestCommitMessage(
    projectId: string,
    requestId: string,
    scope: 'staged' | 'all',
  ): Promise<SuggestGitTextResult>;
  suggestBranchName(projectId: string, requestId: string): Promise<SuggestGitTextResult>;
  resolveWithAi(
    projectId: string,
    path: string,
    requestId: string,
  ): Promise<ResolveConflictWithAiResult>;
  cancelAi(requestId: string): boolean;
}

/** The next release of each size after `latest`, keeping whatever comes before the number. */
export function nextVersions(latest: string | null): {
  patch: string;
  minor: string;
  major: string;
} {
  const match = latest?.match(/^(.*?)(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/);
  if (!match) return { patch: 'v0.0.1', minor: 'v0.1.0', major: 'v1.0.0' };
  const [, prefix = '', a = '0', b = '0', c = '0', pre] = match;
  const [major, minor, patch] = [Number(a), Number(b), Number(c)];
  return {
    patch: `${prefix}${major}.${minor}.${pre ? patch : patch + 1}`,
    minor: `${prefix}${major}.${pre && patch === 0 ? minor : minor + 1}.0`,
    major: `${prefix}${pre && minor === 0 && patch === 0 ? major : major + 1}.0.0`,
  };
}

/** Every next tag on every release channel, with the repository's own prefix kept. */
export function tagChannels(latest: string | null, recent: readonly string[]) {
  const prefix = latest?.match(/^(.*?)\d+\.\d+\.\d+/)?.[1] ?? 'v';
  const next = nextVersions(latest);
  return (['stable', 'beta', 'preview'] as const).map((channel) => ({
    channel,
    options: (['patch', 'minor', 'major'] as const).map((kind) => ({
      kind,
      tag: `${prefix}${versionOnChannel(next[kind].slice(prefix.length), channel, prefix, recent)}`,
    })),
  }));
}

function suggestion(result: SuggestGitTextResult) {
  return {
    ok: result.ok,
    text: result.text ?? null,
    cliName: result.cliName ?? null,
    error: result.error ?? null,
    cancelled: result.cancelled === true,
  };
}

/** Past these a diff is no use on a phone, and would only cost its memory. */
const MAX_DIFF_LINES = 3000;
const MAX_DIFF_CHARS = 256 * 1024;
const MAX_PATHS = 1000;
const MAX_MESSAGE_CHARS = 16 * 1024;
const NOT_SHOWN: Pick<ManageGitDiff, 'tooLarge' | 'lines'> = { tooLarge: true, lines: [] };

const HEADER =
  /^(diff --git |index |similarity index |rename (from|to) |old mode |new mode |new file mode |deleted file mode )/;

function capped(lines: ManageGitDiffLine[]): Pick<ManageGitDiff, 'tooLarge' | 'lines'> {
  const chars = lines.reduce((total, line) => total + line.text.length, 0);
  if (lines.length > MAX_DIFF_LINES || chars > MAX_DIFF_CHARS) return NOT_SHOWN;
  return { tooLarge: false, lines };
}

/** The changed lines of `git diff` output, without its file headers. */
export function parseUnifiedDiff(raw: string): Pick<ManageGitDiff, 'tooLarge' | 'lines'> {
  const lines: ManageGitDiffLine[] = [];
  let inHunk = false;
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      lines.push({ kind: 'hunk', text: line });
    } else if (!inHunk) {
      if (HEADER.test(line)) continue;
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'del', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      lines.push({ kind: 'ctx', text: line.slice(1) });
    }
  }
  return capped(lines);
}

/** A new file, as every line added. */
export function untrackedLines(text: string): Pick<ManageGitDiff, 'tooLarge' | 'lines'> {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return capped(body.split('\n').map((line) => ({ kind: 'add' as const, text: line })));
}

function field(params: unknown, name: string): unknown {
  return (params as Record<string, unknown> | null | undefined)?.[name];
}

function text(params: unknown, name: string, say: string): string {
  const value = field(params, name);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ManageError('bad-params', say);
  }
  return value;
}

function project(params: unknown): string {
  return text(params, 'projectId', 'Say which project.');
}

function requestOf(params: unknown): string {
  const value = text(params, 'requestId', 'Say which request.');
  if (value.length > 128) throw new ManageError('bad-params', 'That request is not valid.');
  return value;
}

function paths(params: unknown): string[] {
  const value = field(params, 'paths');
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PATHS ||
    !value.every((path) => typeof path === 'string' && path.length > 0)
  ) {
    throw new ManageError('bad-params', 'Say which files.');
  }
  return value as string[];
}

function oneOf<T extends string>(params: unknown, name: string, allowed: readonly T[]): T {
  const value = field(params, name);
  if (!allowed.includes(value as T)) {
    throw new ManageError('bad-params', `That is not a valid ${name}.`);
  }
  return value as T;
}

function plain(result: GitOpResult): GitOpResult {
  return { ok: result.ok, message: result.message };
}

/** Git for a phone. Only names of files in a repository cross the link, never where it is. */
export function gitMethods(git: ManageGitDeps): Calls {
  return {
    'git.state': async (params) => {
      const { head: _head, projectPrefix: _prefix, ...state } = await git.state(project(params));
      return state;
    },
    'git.diff': async (params): Promise<ManageGitDiff> => {
      const path = text(params, 'path', 'Say which file.');
      const side = oneOf(params, 'side', ['staged', 'unstaged', 'untracked'] as const);
      const orig = field(params, 'origPath');
      const raw = await git.diff(
        project(params),
        path,
        side,
        typeof orig === 'string' ? orig : undefined,
      );
      if (raw.binary || raw.tooLarge) {
        return { path, binary: raw.binary, tooLarge: raw.tooLarge, lines: [] };
      }
      const body =
        raw.untracked !== null ? untrackedLines(raw.untracked) : parseUnifiedDiff(raw.raw);
      return { path, binary: false, ...body };
    },
    'git.branches': async (params) => git.branches(project(params)),
    'git.stashes': async (params) => git.stashes(project(params)),
    'git.stage': async (params) => plain(await git.stage(project(params), paths(params))),
    'git.unstage': async (params) => plain(await git.unstage(project(params), paths(params))),
    'git.discard': async (params) =>
      plain(
        await git.discard(
          project(params),
          paths(params),
          oneOf(params, 'side', ['unstaged', 'untracked'] as const),
        ),
      ),
    'git.commit': async (params) => {
      const message = text(params, 'message', 'Write a commit message first.');
      if (message.length > MAX_MESSAGE_CHARS) {
        throw new ManageError('bad-params', 'That commit message is too long.');
      }
      return plain(await git.commit(project(params), message, field(params, 'push') === true));
    },
    'git.fetch': async (params) => plain(await git.fetch(project(params))),
    'git.pull': async (params) => plain(await git.pull(project(params))),
    'git.push': async (params) => plain(await git.push(project(params))),
    'git.tags': async (params) => {
      const info = await git.tags(project(params));
      return {
        latest: info.latestTag,
        recent: info.recentTags,
        commitsSince: info.commitsSinceLatestTag,
        hasRemote: info.hasRemote,
        channels: tagChannels(info.latestTag, info.recentTags),
      };
    },
    'git.deleteTag': async (params) => {
      const remote = field(params, 'remote');
      if (typeof remote !== 'boolean')
        throw new ManageError('bad-params', 'Here only, or there too?');
      return plain(
        await git.deleteTag(project(params), text(params, 'tag', 'Say which tag.'), remote),
      );
    },
    'git.suggestTag': async (params) => {
      const result = await git.suggestTag(project(params), requestOf(params));
      return {
        ok: result.ok,
        tag: result.tag ?? null,
        reason: result.reason ?? null,
        message: result.message ?? null,
        cliName: result.cliName ?? null,
        error: result.error ?? null,
        cancelled: result.cancelled === true,
      };
    },
    'git.createTag': async (params) => {
      const message = field(params, 'message');
      if (message !== undefined && message !== null && typeof message !== 'string') {
        throw new ManageError('bad-params', 'That message could not be read.');
      }
      if (typeof message === 'string' && message.length > MAX_MESSAGE_CHARS) {
        throw new ManageError('bad-params', 'That message is too long.');
      }
      const push = field(params, 'push');
      if (typeof push !== 'boolean') throw new ManageError('bad-params', 'Push it or not?');
      return plain(
        await git.createTag({
          projectId: project(params),
          tag: text(params, 'tag', 'Name the tag.'),
          message: message ?? undefined,
          push,
        }),
      );
    },
    'git.suggestCommitMessage': async (params) =>
      suggestion(
        await git.suggestCommitMessage(
          project(params),
          requestOf(params),
          oneOf(params, 'scope', ['staged', 'all'] as const),
        ),
      ),
    'git.suggestBranchName': async (params) =>
      suggestion(await git.suggestBranchName(project(params), requestOf(params))),
    'git.resolveWithAi': async (params) => {
      const result = await git.resolveWithAi(
        project(params),
        text(params, 'path', 'Say which file.'),
        requestOf(params),
      );
      return {
        ok: result.ok,
        message: result.message,
        summary: result.summary ?? null,
        cancelled: result.cancelled === true,
      };
    },
    'git.cancelAi': async (params) => ({ cancelled: git.cancelAi(requestOf(params)) }),
    'git.checkout': async (params) =>
      plain(await git.checkout(project(params), text(params, 'name', 'Say which branch.'))),
    'git.createBranch': async (params) =>
      plain(await git.createBranch(project(params), text(params, 'name', 'Name the branch.'))),
    'git.deleteBranch': async (params) =>
      plain(await git.deleteBranch(project(params), text(params, 'name', 'Say which branch.'))),
    'git.stashPush': async (params) => {
      const message = field(params, 'message');
      return plain(
        await git.stashPush(project(params), typeof message === 'string' ? message : undefined),
      );
    },
    'git.stashPop': async (params) =>
      plain(await git.stashPop(project(params), text(params, 'ref', 'Say which stash.'))),
    'git.stashDrop': async (params) =>
      plain(await git.stashDrop(project(params), text(params, 'ref', 'Say which stash.'))),
    'git.resolve': async (params) =>
      plain(
        await git.resolve(
          project(params),
          text(params, 'path', 'Say which file.'),
          oneOf(params, 'pick', ['ours', 'theirs'] as const),
        ),
      ),
    'git.abort': async (params) => plain(await git.abort(project(params))),
  };
}
