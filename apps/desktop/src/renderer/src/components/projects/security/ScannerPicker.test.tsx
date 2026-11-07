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
});
