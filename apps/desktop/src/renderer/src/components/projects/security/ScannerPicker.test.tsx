import type { ScannerPreflight } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const navigate = vi.fn();
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { ScannerPicker } = await import('./ScannerPicker');

/**
 * A scanner that is not installed says so and offers to fix it. The fix is Dev Setup's Security
 * checklist, which installs the scanners once for every project.
 */

const missingSemgrep: ScannerPreflight = {
  scannerId: 'semgrep',
  ready: false,
  requirements: [
    {
      id: 'binary',
      label: 'Semgrep is installed',
      status: 'unmet',
      blocking: true,
      remedy: 'Install Semgrep from the Dev Tools page.',
      action: { kind: 'install-tool', toolId: 'semgrep' },
      detail: null,
    },
  ],
};

describe('ScannerPicker', () => {
  it("sends Install to Dev Setup's Security checklist", async () => {
    const { user } = renderWithProviders(
      <ScannerPicker
        preflight={[missingSemgrep]}
        loading={false}
        selection={[]}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
        disabled={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Install' }));

    expect(navigate).toHaveBeenCalledWith('/tools?tab=dev-setup&stack=security');
  });

  it('opens settings for a scanner that is already ready', async () => {
    const onConfigure = vi.fn();
    const { user } = renderWithProviders(
      <ScannerPicker
        preflight={[readySemgrep]}
        loading={false}
        selection={['semgrep']}
        onToggle={vi.fn()}
        onConfigure={onConfigure}
        disabled={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Semgrep settings' }));

    expect(onConfigure).toHaveBeenCalledWith('semgrep');
  });

  it('has no settings button for a scanner with nothing to set', () => {
    renderWithProviders(
      <ScannerPicker
        preflight={[{ scannerId: 'bearer', ready: true, requirements: [] }]}
        loading={false}
        selection={[]}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
        disabled={false}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Bearer settings' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Semgrep settings' })).toBeInTheDocument();
  });

  it('keeps settings closed until the saved settings have loaded', () => {
    renderWithProviders(
      <ScannerPicker
        preflight={[readySemgrep]}
        loading={false}
        selection={[]}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
        disabled={false}
        configLoading
      />,
    );

    expect(screen.getByRole('button', { name: 'Semgrep settings' })).toBeDisabled();
  });

  it('offers a fresh check once Docker has been started', async () => {
    const onRecheck = vi.fn();
    const { user } = renderWithProviders(
      <ScannerPicker
        preflight={[dockerDown]}
        loading={false}
        selection={[]}
        onToggle={vi.fn()}
        onConfigure={vi.fn()}
        onRecheck={onRecheck}
        disabled={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});

const readySemgrep: ScannerPreflight = { scannerId: 'semgrep', ready: true, requirements: [] };

const dockerDown: ScannerPreflight = {
  scannerId: 'bearer',
  ready: false,
  requirements: [
    {
      id: 'docker-running',
      label: 'Docker is available',
      status: 'unmet',
      blocking: true,
      remedy: 'Docker is installed but not running. Start Docker Desktop.',
      action: { kind: 'start-docker' },
      detail: null,
    },
  ],
};
