import type {
  ManageGitBranch,
  ManageGitDiff,
  ManageGitDiffLine,
  ManageGitStash,
} from '@runova/protocol';
import type { GitOpResult, WorkspaceGitState } from '../../../shared/apiTypes';
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
