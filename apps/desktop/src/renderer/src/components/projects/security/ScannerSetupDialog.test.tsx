import type { SecurityScannerId, SecurityScannerSettings } from '@runova/core';
import { STRIX_DEFAULT_MODEL } from '@runova/core';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { ScannerSetupDialog } = await import('./ScannerSetupDialog');

/**
 * What the setup dialog shows is what gets saved. A field that displays a default the user left
 * alone has to store that default, otherwise preflight keeps asking for a value the user can see
 * is already there.
 */

function open(
  scannerId: SecurityScannerId,
  config: SecurityScannerSettings = {},
  onSuggestLanguage: () => Promise<string | null> = async () => null,
) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const view = renderWithProviders(
    <ScannerSetupDialog
      scannerId={scannerId}
      config={config}
      projectName="Shop"
      onClose={onClose}
      onSave={onSave}
      onSuggestLanguage={onSuggestLanguage}
    />,
  );
  return { ...view, onSave, onClose };
}

describe('ScannerSetupDialog', () => {
  it('saves the default Strix model when only the API key was typed', async () => {
    const { user, onSave } = open('strix');

    await user.type(screen.getByLabelText('LLM API key'), 'sk-test');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ strixApiKey: 'sk-test', strixModel: STRIX_DEFAULT_MODEL }),
    );
  });

  it('saves the default SonarQube URL when the field was left as shown', async () => {
    const { user, onSave } = open('sonarqube');

    await user.type(screen.getByLabelText('Token'), 'squ_abc');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ sonarUrl: 'http://localhost:9000', sonarToken: 'squ_abc' }),
    );
  });

  it('lets Trivy choose what it looks for', async () => {
    const { user, onSave } = open('trivy', { trivyScanners: ['vuln', 'secret'] });

    expect(screen.getByRole('checkbox', { name: /Vulnerable dependencies/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Misconfigurations/ })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /Misconfigurations/ }));
    await user.click(screen.getByRole('checkbox', { name: /Secrets/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ trivyScanners: ['vuln', 'misconfig'] }),
    );
  });

  it('will not save Trivy with nothing to look for', async () => {
    const { user } = open('trivy', { trivyScanners: ['vuln'] });

    await user.click(screen.getByRole('checkbox', { name: /Vulnerable dependencies/ }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('says so when language detection fails', async () => {
    const { user } = open('codeql', {}, async () => {
      throw new Error('folder is gone');
    });

    await user.click(screen.getByRole('button', { name: 'Detect' }));

    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/folder is gone/));
    expect(screen.getByRole('button', { name: 'Detect' })).toBeEnabled();
  });

  it('says so when no language could be detected', async () => {
    const { user } = open('codeql');

    await user.click(screen.getByRole('button', { name: 'Detect' }));

    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/could not tell/i));
  });
});
