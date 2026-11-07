import type { Project, SecurityScanRecord } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectUiScope } from '@/hooks/useProjectUiState';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { SecurityTab } = await import('./SecurityTab');

/**
 * The tab as someone opens it: what it says when the scanner check itself fails, that it does not
 * flash "nothing installed" before the last report arrives, and how history works.
 */

const project = { id: 'p1', name: 'Shop', folderPath: '/work/shop' } as Project;

function record(over: Partial<SecurityScanRecord> = {}): SecurityScanRecord {
  return {
    id: 'scan-latest',
    projectId: 'p1',
    projectName: 'Shop',
    status: 'complete',
    verdict: 'caution',
    score: 70,
    findings: [],
    runs: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    durationMs: 1000,
    options: {
      scannerIds: ['semgrep'],
      semgrepConfig: 'auto',
      trivyScanners: ['vuln'],
      codeqlLanguage: null,
      codeqlBuildCommand: null,
      sonarProjectKey: null,
      includeInfo: false,
      maxFindingsPerScanner: 2000,
    },
    createdAt: '2026-11-05T10:00:00Z',
    ...over,
  };
}

const readySemgrep = { scannerId: 'semgrep', ready: true, requirements: [] };

describe('SecurityTab', () => {
  it('says the scanner check failed, with a retry, instead of claiming nothing is installed', async () => {
    let fail = true;
    const { user, bridge } = renderWithProviders(<SecurityTab project={project} />, {
      bridge: {
        'security.preflight': async () => {
          if (fail) throw new Error('probe crashed');
          return [readySemgrep];
        },
      },
    });

    expect(await screen.findByText(/Could not check the scanners/)).toBeInTheDocument();
    expect(screen.getByText(/probe crashed/)).toBeInTheDocument();
    expect(screen.queryByText('No security scanners installed yet')).toBeNull();

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(screen.queryByText(/Could not check the scanners/)).toBeNull());
    expect(bridge.$fn('security.preflight')).toHaveBeenLastCalledWith('p1', { force: true });
  });

  it('does not flash the empty state before the last report has loaded', async () => {
    renderWithProviders(<SecurityTab project={project} />, {
      bridge: {
        'security.preflight': [],
        'security.latest': () => new Promise(() => undefined),
      },
    });

    // The scanner cards have their answer (nothing ready); the report is still on its way.
    expect((await screen.findAllByText('Not available')).length).toBeGreaterThan(0);
    expect(screen.queryByText('No security scanners installed yet')).toBeNull();
  });

  it('opens an older scan from history and goes back to the latest', async () => {
    const old = record({ id: 'scan-old', score: 40, createdAt: '2026-10-01T10:00:00Z' });
    const { user } = renderWithProviders(<SecurityTab project={project} />, {
      bridge: {
        'security.preflight': [readySemgrep],
        'security.latest': record(),
        'security.history': [record(), old],
        'security.getScan': old,
      },
    });

    await user.click(await screen.findByRole('button', { name: /History/ }));
    await user.click(await screen.findByRole('menuitem', { name: /40/ }));

    expect(await screen.findByText(/Viewing a scan from/)).toBeInTheDocument();
    expect(screen.getByText('Score 40/100')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to latest' }));

    expect(await screen.findByText('Score 70/100')).toBeInTheDocument();
    expect(screen.queryByText(/Viewing a scan from/)).toBeNull();
  });

  it('deletes a scan from history', async () => {
    const old = record({ id: 'scan-old', score: 40, createdAt: '2026-10-01T10:00:00Z' });
    const { user, bridge } = renderWithProviders(<SecurityTab project={project} />, {
      bridge: {
        'security.preflight': [readySemgrep],
        'security.latest': record(),
        'security.history': [record(), old],
      },
    });

    await user.click(await screen.findByRole('button', { name: /History/ }));
    const deleteButtons = await screen.findAllByRole('menuitem', { name: /Delete scan from/ });
    await user.click(deleteButtons[1]);

    await waitFor(() => expect(bridge.$fn('security.deleteScan')).toHaveBeenCalledWith('scan-old'));
  });

  it('switches between the scanners and the AI audit, and remembers the choice per project', async () => {
    const { user, unmount } = renderWithProviders(
      <ProjectUiScope.Provider value="p1">
        <SecurityTab project={project} />
      </ProjectUiScope.Provider>,
      { bridge: { 'security.preflight': [readySemgrep], 'security.latest': record() } },
    );

    expect(await screen.findByRole('tab', { name: /Scanners/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: /AI audit/ }));
    expect(await screen.findByText(/Find what scanners miss/)).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <ProjectUiScope.Provider value="p1">
        <SecurityTab project={project} />
      </ProjectUiScope.Provider>,
      { bridge: { 'security.preflight': [readySemgrep] } },
    );
    expect(await screen.findByRole('tab', { name: /AI audit/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
