import type { PackageInfo, PackageManagerSection } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectUiScope } from '@/hooks/useProjectUiState';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { project } from '../health/testing/fixtures';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { PackagesTab } = await import('./PackagesTab');

/**
 * The details page is unmounted whenever the user leaves it for the Workspace, so what was
 * ticked, filtered or typed in the Packages tab has to be there again on the way back.
 */

function pkg(overrides: Partial<PackageInfo>): PackageInfo {
  return {
    name: 'next',
    currentVersion: '15.0.0',
    latestVersion: '16.0.0',
    isOutdated: true,
    isDev: false,
    isInstalled: true,
    manifestPath: 'C:\\work\\web\\package.json',
    projectLabel: 'web',
    ...overrides,
  };
}

const section: PackageManagerSection = {
  ecosystem: 'node',
  manager: 'npm',
  status: 'ok',
  message: null,
  packages: [pkg({ name: 'next' }), pkg({ name: 'react' }), pkg({ name: 'vitest', isDev: true })],
  runtimes: [],
  toolchain: 'node',
};

function renderTab(projectId = 'p1') {
  return renderWithProviders(
    <ProjectUiScope.Provider value={projectId}>
      <PackagesTab project={project({ id: projectId })} />
    </ProjectUiScope.Provider>,
    {
      bridge: {
        'packages.list': { projectId, sections: [section] },
        'devSetup.detect': async () => ({ state: 'found', version: '1', path: 'x', onPath: true }),
        'devSetup.updates': async (ids: string[]) =>
          Object.fromEntries(ids.map((id) => [id, { state: 'current' }])),
      },
    },
  );
}

describe('PackagesTab after leaving and coming back', () => {
  it('keeps the packages that were ticked', async () => {
    const first = renderTab();
    await first.user.click(await screen.findByRole('checkbox', { name: 'Select react' }));
    expect(screen.getByRole('checkbox', { name: 'Select react' })).toBeChecked();
    first.unmount();

    renderTab();

    expect(await screen.findByRole('checkbox', { name: 'Select react' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select next' })).not.toBeChecked();
  });

  it('keeps the filter and the search text', async () => {
    const first = renderTab();
    await first.user.click(await screen.findByRole('radio', { name: /^Dev/ }));
    await first.user.type(screen.getByLabelText('Search packages'), 'vit');
    first.unmount();

    renderTab();

    expect(await screen.findByRole('radio', { name: /^Dev/ })).toBeChecked();
    expect(screen.getByLabelText('Search packages')).toHaveValue('vit');
    expect(screen.getByText('vitest')).toBeInTheDocument();
    expect(screen.queryByText('react')).not.toBeInTheDocument();
  });

  it('starts another project clean', async () => {
    const first = renderTab('p1');
    await first.user.click(await screen.findByRole('checkbox', { name: 'Select react' }));
    await first.user.type(screen.getByLabelText('Search packages'), 'rea');
    first.unmount();

    renderTab('p2');

    expect(await screen.findByRole('checkbox', { name: 'Select react' })).not.toBeChecked();
    expect(screen.getByLabelText('Search packages')).toHaveValue('');
  });
});
