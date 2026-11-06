import type { PackageInfo, PackageManagerSection } from '@shared/apiTypes';
import type { DependencyAlertsSummary, ProjectFindings } from '@shared/dependencyAlerts';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { project } from '../health/testing/fixtures';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { PackagesTab } = await import('./PackagesTab');

/** The Packages tab marks what the daily check found (E51), and can mute this project's alerts. */

function pkg(name: string, currentVersion: string): PackageInfo {
  return {
    name,
    currentVersion,
    latestVersion: currentVersion,
    isOutdated: false,
    isDev: false,
    isInstalled: true,
    manifestPath: 'C:\work\shop\package.json',
    projectLabel: 'shop',
  };
}

const section: PackageManagerSection = {
  ecosystem: 'node',
  manager: 'npm',
  status: 'ok',
  message: null,
  packages: [pkg('lodash', '4.17.20'), pkg('request', '2.88.2'), pkg('react', '19.1.0')],
  runtimes: [],
  toolchain: 'npm',
};

function findings(muted = false): ProjectFindings {
  return {
    inventoryId: 7,
    scopeId: 1,
    itemId: 'p1',
    projectName: 'Shop',
    muted,
    lastCheckedAt: '2026-11-06T09:00:00.000Z',
    total: muted ? 0 : 2,
    worstSeverity: 'high',
    counts: { security: 1, deprecated: 1, major: 0, minor: 0, patch: 0 },
    findings: [
      {
        ecosystem: 'npm',
        name: 'lodash',
        kind: 'security',
        currentVersion: '4.17.20',
        targetVersion: '4.17.21',
        advisoryId: 'GHSA-35jh-r3h4-6jhm',
        severity: 'high',
        summary: 'Command injection in lodash',
        firstSeenAt: '2026-11-06T09:00:00.000Z',
      },
      {
        ecosystem: 'npm',
        name: 'request',
        kind: 'deprecated',
        currentVersion: '2.88.2',
        targetVersion: null,
        advisoryId: null,
        severity: null,
        summary: 'request has been deprecated',
        firstSeenAt: '2026-11-06T09:00:00.000Z',
      },
    ],
  };
}

function summary(entry: ProjectFindings): DependencyAlertsSummary {
  return {
    signedIn: true,
    enabled: true,
    projectsWithAlerts: entry.muted ? 0 : 1,
    total: entry.total,
    byProject: { p1: entry },
  };
}

function renderTab(entry: ProjectFindings = findings()) {
  return renderWithProviders(<PackagesTab project={project()} />, {
    bridge: {
      'packages.list': { projectId: 'p1', sections: [section] },
      'dependencyAlerts.summary': summary(entry),
      'dependencyAlerts.mute': async (_id: string, muted: boolean) => summary(findings(muted)),
    },
  });
}

describe('PackagesTab dependency alerts', () => {
  it('marks a security issue and a deprecation on their packages', async () => {
    renderTab();

    expect(await screen.findByText('High security issue')).toBeInTheDocument();
    expect(screen.getByText('Deprecated')).toBeInTheDocument();
    const react = screen.getByText('react').closest('div.relative');
    expect(react && within(react as HTMLElement).queryByText(/security|Deprecated/)).toBeNull();
  });

  it('mutes this project, and unmutes it', async () => {
    const { user, bridge } = renderTab();

    const alerts = await screen.findByRole('switch', { name: 'Package alerts for this project' });
    expect(alerts).toBeChecked();
    await user.click(alerts);

    expect(bridge.$fn('dependencyAlerts.mute')).toHaveBeenCalledWith('p1', true);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Package alerts for this project' }),
      ).not.toBeChecked(),
    );
  });

  it('shows no alert controls for a project the check has not seen', async () => {
    renderWithProviders(<PackagesTab project={project()} />, {
      bridge: { 'packages.list': { projectId: 'p1', sections: [section] } },
    });

    expect(await screen.findByText('lodash')).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Package alerts for this project' }),
    ).not.toBeInTheDocument();
  });
});
