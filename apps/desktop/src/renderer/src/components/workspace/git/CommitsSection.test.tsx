import type { Project } from '@runova/core';
import type { GitBranchHistory, GitCommitInfo, WorkspaceGitState } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CommitsSection } from './CommitsSection';

/**
 * The workspace commit list re-reads the branch history only when its query key moves. HEAD was
 * the only repo fact in that key, and tagging HEAD does not move HEAD, so a tag made by a release
 * tool, an agent or the Tag dialog never got its chip until the next commit. The pushed state now
 * carries a tags signature, and these check the list follows it.
 */

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app', cliId: 'claude' } as Project;

function gitState(overrides: Partial<WorkspaceGitState> = {}): WorkspaceGitState {
  return {
    isRepo: true,
    branch: 'master',
    detached: false,
    head: 'c3e1484',
    upstream: 'origin/master',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    operation: null,
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
    untrackedTruncated: false,
    projectPrefix: '',
    tagsSignature: 'before',
    ...overrides,
  };
}

function commit(tags: string[]): GitCommitInfo {
  return {
    hash: 'c3e148487790bb39463adc5802016ab5d4889dc9',
    shortHash: 'c3e1484',
    author: 'Runova Test',
    date: '2026-11-25T04:08:14+03:30',
    subject: 'docs(deploy): realign service table in README',
    parents: ['c00475bbc1d133d5b621357dc03c4fa570b14f67'],
    tags,
  };
}

const history = (tags: string[]): GitBranchHistory => ({
  branch: 'master',
  commits: [commit(tags)],
  activity: [],
});

/** Holds the git state the way the panel does, with a way to swap in the next pushed one. */
function Harness({ next }: { next: WorkspaceGitState }): React.JSX.Element {
  const [state, setState] = useState(gitState());
  return (
    <>
      <button type="button" onClick={() => setState(next)}>
        Push next state
      </button>
      <CommitsSection project={project} state={state} />
    </>
  );
}

describe('CommitsSection', () => {
  it('shows a tag made on HEAD once the tags signature moves, with HEAD unchanged', async () => {
    const branchHistory = vi
      .fn()
      .mockResolvedValueOnce(history([]))
      .mockResolvedValue(history(['v1.2.0']));
    const { user } = renderWithProviders(<Harness next={gitState({ tagsSignature: 'after' })} />, {
      bridge: { 'git.branchHistory': branchHistory },
    });

    expect(await screen.findByText('docs(deploy): realign service table in README')).toBeTruthy();
    expect(screen.queryByText('v1.2.0')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Push next state' }));

    expect(await screen.findByText('v1.2.0')).toBeTruthy();
    expect(branchHistory).toHaveBeenCalledTimes(2);
    expect(branchHistory).toHaveBeenLastCalledWith('p1', 'master');
  });

  it('does not re-read the history for a pushed state with the same HEAD and tags', async () => {
    const branchHistory = vi.fn().mockResolvedValue(history(['v1.1.0']));
    const { user } = renderWithProviders(
      // A file edit: the status changed, the history did not.
      <Harness next={gitState({ unstaged: [{ path: 'README.md', status: 'M' }] })} />,
      { bridge: { 'git.branchHistory': branchHistory } },
    );

    expect(await screen.findByText('v1.1.0')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Push next state' }));

    await waitFor(() => expect(screen.getByText('v1.1.0')).toBeTruthy());
    expect(branchHistory).toHaveBeenCalledTimes(1);
  });
});
