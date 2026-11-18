import type { Project } from '@runova/core';
import type { GithubActionsHistoryItem } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { historyItemToRun, RunDetailsDialog } from './RunDetailsDialog';

const ITEM: GithubActionsHistoryItem & { workflowId: number } = {
  id: 2,
  projectId: 'p2',
  projectName: 'Borealis',
  repo: 'acme/borealis',
  workflowName: 'CI',
  workflowId: 9,
  displayTitle: 'Break the build',
  runNumber: 42,
  headBranch: 'main',
  status: 'completed',
  conclusion: 'failure',
  htmlUrl: 'https://github.com/acme/borealis/actions/runs/2',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:04:00.000Z',
  checkSuiteId: 77,
};

const project = { id: 'p2', name: 'Borealis', folderPath: 'C:\\work\\borealis' } as Project;

describe('historyItemToRun', () => {
  it('carries over what the run details read, and nothing it does not know', () => {
    expect(historyItemToRun(ITEM)).toEqual({
      id: 2,
      workflowId: 9,
      name: 'CI',
      displayTitle: 'Break the build',
      runNumber: 42,
      headBranch: 'main',
      status: 'completed',
      conclusion: 'failure',
      htmlUrl: 'https://github.com/acme/borealis/actions/runs/2',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:04:00.000Z',
    });
  });
});

describe('RunDetailsDialog', () => {
  it('shows the run under its pipeline and number, and closes on Escape', async () => {
    const onOpenChange = vi.fn();
    const { user } = renderWithProviders(
      <RunDetailsDialog item={ITEM} project={project} open onOpenChange={onOpenChange} />,
      { bridge: { 'pipelines.runDetails': { ok: true, jobs: [] } } },
    );

    const dialog = screen.getByRole('dialog', { name: 'CI #42' });
    expect(dialog).toHaveTextContent('acme/borealis');
    expect(screen.getByRole('region', { name: 'CI details' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
