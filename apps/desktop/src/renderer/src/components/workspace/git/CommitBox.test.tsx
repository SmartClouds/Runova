import type { WorkspaceGitState } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { CommitBox } from './CommitBox';
import type { GitActions } from './useWorkspaceGit';

/**
 * The commit split button and its menu. Commit and Commit & push are only enabled when a commit
 * can actually run, so a row that looks live always does something when it is picked.
 */

function gitState(overrides: Record<string, unknown> = {}): WorkspaceGitState {
  return {
    isRepo: true,
    branch: 'main',
    detached: false,
    head: 'abc1234',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    operation: null,
    conflicts: [],
    staged: [],
    unstaged: [{ path: 'src/app.ts', status: 'M' }],
    untracked: [],
    untrackedTruncated: false,
    tagsSignature: '',
    projectPrefix: '',
    ...overrides,
  } as WorkspaceGitState;
}

function gitActions(): GitActions {
  return {
    stage: vi.fn(async () => undefined),
    unstage: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    applyLines: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
    resolveWithAi: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    commit: vi.fn(async () => true),
    stash: vi.fn(async () => undefined),
    stashRestore: vi.fn(async () => undefined),
    stashDrop: vi.fn(async () => undefined),
  };
}

// The message draft is kept outside React per project, so every test gets a project of its own.
let projectCount = 0;

function renderBox(state: WorkspaceGitState) {
  projectCount += 1;
  const actions = gitActions();
  const view = renderWithProviders(
    <CommitBox projectId={`project-${projectCount}`} state={state} actions={actions} />,
  );
  return { ...view, actions };
}

async function openMenu(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'More commit options' }));
  await screen.findByRole('menu');
}

/** Rows are found by their title, since their accessible name also carries the description. */
function menuItem(title: string): HTMLElement {
  const row = screen
    .getAllByRole('menuitem')
    .find((item) =>
      Array.from(item.querySelectorAll('span')).some((span) => span.textContent === title),
    );
  if (!row) throw new Error(`No menu item titled "${title}"`);
  return row;
}

describe('CommitBox menu', () => {
  it('disables Commit and Commit & push until a message is written', async () => {
    const { user } = renderBox(gitState());
    await openMenu(user);

    expect(menuItem('Commit')).toHaveAttribute('aria-disabled', 'true');
    expect(menuItem('Commit')).toHaveTextContent('Write a commit message first');
    expect(menuItem('Commit & push')).toHaveAttribute('aria-disabled', 'true');
  });

  it('commits once a message is written, staging the pending changes first', async () => {
    const { user, actions } = renderBox(gitState());
    await user.type(screen.getByLabelText('Commit message'), 'Fix the parser');
    await openMenu(user);

    expect(menuItem('Commit')).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(menuItem('Commit'));

    await waitFor(() => expect(actions.commit).toHaveBeenCalledWith('Fix the parser', false));
    expect(actions.stage).toHaveBeenCalledWith(['src/app.ts']);
  });

  it('keeps Commit & push off without a remote, and says why', async () => {
    const { user } = renderBox(gitState({ hasRemote: false, upstream: null }));
    await user.type(screen.getByLabelText('Commit message'), 'Fix the parser');
    await openMenu(user);

    expect(menuItem('Commit')).not.toHaveAttribute('aria-disabled', 'true');
    expect(menuItem('Commit & push')).toHaveAttribute('aria-disabled', 'true');
    expect(menuItem('Commit & push')).toHaveTextContent('Add a remote to push this repository');
  });

  it('holds Keep Staged back while nothing is staged, and Stash All still runs', async () => {
    const { user, actions } = renderBox(gitState());
    await openMenu(user);

    const keepStaged = menuItem('Stash All and Keep Staged (--keep-index)');
    expect(keepStaged).toHaveAttribute('aria-disabled', 'true');
    expect(keepStaged).toHaveTextContent('Stage something first, or use Stash All');

    await user.click(menuItem('Stash All (--include-untracked)'));
    await waitFor(() => expect(actions.stash).toHaveBeenCalledWith('all'));
  });

  it('runs Keep Staged once something is staged', async () => {
    const { user, actions } = renderBox(
      gitState({ staged: [{ path: 'src/app.ts', status: 'M' }], unstaged: [] }),
    );
    await openMenu(user);

    expect(menuItem('Stash All and Keep Staged (--keep-index)')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(menuItem('Stash All and Keep Staged (--keep-index)'));

    await waitFor(() => expect(actions.stash).toHaveBeenCalledWith('keep-staged'));
  });

  it('has no menu to open on a clean tree', () => {
    renderBox(gitState({ unstaged: [] }));
    expect(screen.getByRole('button', { name: 'More commit options' })).toBeDisabled();
  });
});
