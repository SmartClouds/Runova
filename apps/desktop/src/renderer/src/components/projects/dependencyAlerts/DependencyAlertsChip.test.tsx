import type { DependencyAlertsSummary, ProjectFindings } from '@shared/dependencyAlerts';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DependencyAlertsChip } from './DependencyAlertsChip';

function project(overrides: Partial<ProjectFindings> = {}): ProjectFindings {
  return {
    inventoryId: 7,
    scopeId: 1,
    itemId: 'p1',
    projectName: 'Shop',
    muted: false,
    lastCheckedAt: '2026-11-06T09:00:00.000Z',
    total: 3,
    worstSeverity: null,
    counts: { security: 0, deprecated: 1, major: 2, minor: 0, patch: 0 },
    findings: [],
    ...overrides,
  };
}

function summary(entry: ProjectFindings | null): DependencyAlertsSummary {
  return {
    signedIn: true,
    enabled: true,
    projectsWithAlerts: entry && entry.total > 0 ? 1 : 0,
    total: entry?.total ?? 0,
    byProject: entry ? { p1: entry } : {},
  };
}

describe('DependencyAlertsChip', () => {
  it('counts the updates and opens the Packages tab, without opening the card', async () => {
    const onOpen = vi.fn();
    const onCard = vi.fn();
    const { user } = renderWithProviders(
      <div onClick={onCard}>
        <DependencyAlertsChip projectId="p1" onOpen={onOpen} />
      </div>,
      { bridge: { 'dependencyAlerts.summary': summary(project()) } },
    );

    await user.click(
      await screen.findByRole('button', {
        name: '3 package updates in this project. Open Packages.',
      }),
    );

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onCard).not.toHaveBeenCalled();
  });

  it('says a security issue first, with its severity', async () => {
    renderWithProviders(<DependencyAlertsChip projectId="p1" onOpen={vi.fn()} />, {
      bridge: {
        'dependencyAlerts.summary': summary(
          project({
            total: 2,
            worstSeverity: 'critical',
            counts: { security: 1, deprecated: 0, major: 1, minor: 0, patch: 0 },
          }),
        ),
      },
    });

    expect(
      await screen.findByRole('button', {
        name: '2 package updates in this project, 1 of them a critical security issue. Open Packages.',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 security')).toBeInTheDocument();
  });

  it.each([
    ['no alerts', summary(project({ total: 0 })), 'p1'],
    ['muted', summary(project({ muted: true })), 'p1'],
    ['never checked', summary(project()), 'other'],
  ])('shows nothing for a project with %s', async (_, answer, projectId) => {
    const { bridge } = renderWithProviders(
      <DependencyAlertsChip projectId={projectId} onOpen={vi.fn()} />,
      {
        bridge: { 'dependencyAlerts.summary': answer },
      },
    );

    await waitFor(() => expect(bridge.$fn('dependencyAlerts.summary')).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('never repeats the project name in its accessible name', async () => {
    renderWithProviders(<DependencyAlertsChip projectId="p1" onOpen={vi.fn()} />, {
      bridge: { 'dependencyAlerts.summary': summary(project({ projectName: 'Shop' })) },
    });

    const button = await screen.findByRole('button');
    expect(button.getAttribute('aria-label')).not.toContain('Shop');
  });
});
