import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ScanProgressPanel } from './ScanProgressPanel';

/**
 * Cancelling takes a moment (process trees and containers have to go), so the button has to say
 * it heard the click, and each scanner row has to end on what actually happened to it.
 */

describe('ScanProgressPanel', () => {
  it('shows the cancel was heard and does not take a second click', async () => {
    const onCancel = vi.fn();
    const { user } = renderWithProviders(
      <ScanProgressPanel selection={['semgrep']} progress={{}} onCancel={onCancel} />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Cancelling...' })).toBeDisabled();
  });

  it('labels each scanner by how it ended', () => {
    const at = Date.now();
    renderWithProviders(
      <ScanProgressPanel
        selection={['semgrep', 'trivy', 'codeql']}
        progress={{
          semgrep: { phase: 'cancelled', message: '', startedAt: at, lines: [] },
          trivy: { phase: 'timed-out', message: '', startedAt: at, lines: [] },
          codeql: { phase: 'skipped', message: '', startedAt: at, lines: [] },
        }}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Timed out').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Skipped').length).toBeGreaterThan(0);
  });
});
