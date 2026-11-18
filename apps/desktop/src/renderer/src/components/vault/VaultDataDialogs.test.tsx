// @vitest-environment jsdom
import type { VaultImportPreview } from '@shared/apiTypes';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVaultApiMock,
  expectNoNativeTitles,
  installDomShims,
  installVaultApi,
  MOCK_PHRASE_ID,
  MOCK_PHRASE_WORDS,
  renderWithVaultProviders,
  type VaultApiMock,
} from './testing/mockVaultApi';

installDomShims();

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { VaultImportDialog } = await import('./VaultImportDialog');
const { VaultExportDialog } = await import('./VaultExportDialog');
const { ChangeMasterPasswordDialog } = await import('./ChangeMasterPasswordDialog');

let mock: VaultApiMock;
const onOpenChange = vi.fn();

function preview(overrides: Partial<VaultImportPreview> = {}): VaultImportPreview {
  return {
    token: 'tok',
    fileName: 'bitwarden_export.csv',
    format: 'bitwarden',
    headers: ['folder', 'favorite', 'type', 'name'],
    mapping: { columns: ['tags', 'favorite', 'extra', 'title'] },
    rowCount: 3,
    importable: 2,
    duplicates: { identical: 0, conflict: 0 },
    skipped: [{ row: 4, reason: 'Unsupported item type "card"' }],
    sample: [
      { type: 'login', title: 'GitHub', username: 'octocat', host: 'github.com' },
      { type: 'note', title: 'Wi-Fi codes', username: '', host: '' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mock = createVaultApiMock();
  installVaultApi(mock);
  vi.clearAllMocks();
  mock.api.importCommit.mockResolvedValue({ added: 2, replaced: 0, skipped: 0, invalid: [] });
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('VaultImportDialog', () => {
  const choose = () => fireEvent.click(screen.getByRole('button', { name: 'Choose CSV file' }));

  it('stays put when the file picker is cancelled', async () => {
    renderWithVaultProviders(<VaultImportDialog open onOpenChange={onOpenChange} />);
    choose();
    await waitFor(() => expect(mock.api.importOpen).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Choose CSV file' })).toBeTruthy();
  });

  it('previews a recognized export and imports it', async () => {
    mock.api.importOpen.mockResolvedValue(preview());
    renderWithVaultProviders(<VaultImportDialog open onOpenChange={onOpenChange} />);
    choose();
    const dialog = await screen.findByRole('dialog', { name: 'Import passwords' });
    expect(await within(dialog).findByText('bitwarden_export.csv')).toBeTruthy();
    expect(within(dialog).getByText('Bitwarden')).toBeTruthy();
    expect(within(dialog).getByText('GitHub')).toBeTruthy();
    expect(within(dialog).getByText(/1 row can't be imported/)).toBeTruthy();
    expect(within(dialog).getByText(/delete the CSV file/i)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 2 entries' }));
    await waitFor(() => expect(mock.api.importCommit).toHaveBeenCalledWith('tok', null, 'skip'));
    expect(await within(dialog).findByText('Imported 2 entries')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mock.api.importCancel).not.toHaveBeenCalled();
  });

  it('asks what to do with entries that differ from saved ones', async () => {
    mock.api.importOpen.mockResolvedValue(preview({ duplicates: { identical: 1, conflict: 1 } }));
    renderWithVaultProviders(<VaultImportDialog open onOpenChange={onOpenChange} />);
    choose();
    const dialog = await screen.findByRole('dialog', { name: 'Import passwords' });
    expect(await within(dialog).findByText(/1 already in your vault/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Replace the saved entry/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Import/ }));
    await waitFor(() => expect(mock.api.importCommit).toHaveBeenCalledWith('tok', null, 'replace'));
  });

  it('lets you match columns for an unknown file', async () => {
    const generic = preview({
      format: null,
      fileName: 'passwords.csv',
      headers: ['Site', 'Login', 'Secret'],
      mapping: { columns: ['title', 'username', 'password'] },
    });
    mock.api.importOpen.mockResolvedValue(generic);
    mock.api.importPreview.mockResolvedValue({
      ...generic,
      mapping: { columns: ['title', 'ignore', 'password'] },
    });
    renderWithVaultProviders(<VaultImportDialog open onOpenChange={onOpenChange} />);
    choose();
    const dialog = await screen.findByRole('dialog', { name: 'Import passwords' });
    const select = await within(dialog).findByLabelText('Column "Login"');
    fireEvent.change(select, { target: { value: 'ignore' } });
    await waitFor(() =>
      expect(mock.api.importPreview).toHaveBeenCalledWith('tok', {
        columns: ['title', 'ignore', 'password'],
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: /^Import/ }));
    await waitFor(() =>
      expect(mock.api.importCommit).toHaveBeenCalledWith(
        'tok',
        { columns: ['title', 'ignore', 'password'] },
        'skip',
      ),
    );
  });

  it('forgets the file when closed before importing', async () => {
    mock.api.importOpen.mockResolvedValue(preview());
    renderWithVaultProviders(<VaultImportDialog open onOpenChange={onOpenChange} />);
    choose();
    const dialog = await screen.findByRole('dialog', { name: 'Import passwords' });
    await within(dialog).findByText('bitwarden_export.csv');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mock.api.importCancel).toHaveBeenCalledWith('tok');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows why a file could not be read', async () => {
    mock.api.importOpen.mockRejectedValue(
      new Error(
        "Error invoking remote method 'vault:importOpen': Error: [vault:invalid] That file is larger than 10 MB.",
      ),
    );
    renderWithVaultProviders(<VaultImportDialog open onOpenChange={onOpenChange} />);
    choose();
    expect((await screen.findByRole('alert')).textContent).toContain('larger than 10 MB');
  });
});

describe('VaultExportDialog', () => {
  const password = () => screen.getByLabelText('Master password');
  const exportButton = () => screen.getByRole('button', { name: 'Export' });

  it('warns about plain text, needs the password and exports the chosen format', async () => {
    renderWithVaultProviders(<VaultExportDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByText(/plain text/i)).toBeTruthy();
    expect(exportButton().hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Bitwarden/ }));
    fireEvent.change(password(), { target: { value: 'correct horse battery' } });
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(mock.api.exportCsv).toHaveBeenCalledWith('correct horse battery', 'bitwarden'),
    );
    expect(toast.success).toHaveBeenCalledWith('Vault exported', expect.anything());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says so when the password is wrong and stays quiet when the save dialog is cancelled', async () => {
    mock.api.exportCsv.mockResolvedValueOnce({ ok: false, reason: 'wrong-password' });
    mock.api.exportCsv.mockResolvedValueOnce({ ok: false, reason: 'cancelled' });
    renderWithVaultProviders(<VaultExportDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(password(), { target: { value: 'nope nope' } });
    fireEvent.click(exportButton());
    expect((await screen.findByRole('alert')).textContent).toMatch(/doesn't match/);

    fireEvent.change(password(), { target: { value: 'right one' } });
    fireEvent.click(exportButton());
    await waitFor(() => expect(mock.api.exportCsv).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('ChangeMasterPasswordDialog', () => {
  const STRONG = 'violet lantern orbit 42';
  const fill = (current: string, next: string, again = next) => {
    const own = screen.queryByRole('button', { name: 'Type my own password' });
    if (own?.getAttribute('aria-pressed') === 'false') fireEvent.click(own);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('Type the new password again'), {
      target: { value: again },
    });
  };
  const change = () => screen.getByRole('button', { name: 'Change password' });

  it('only allows a strong, confirmed new password', () => {
    renderWithVaultProviders(<ChangeMasterPasswordDialog open onOpenChange={onOpenChange} />);
    fill('old password here', 'weak');
    expect(change().hasAttribute('disabled')).toBe(true);
    fill('old password here', STRONG, `${STRONG}x`);
    expect(change().hasAttribute('disabled')).toBe(true);
    fill('old password here', STRONG);
    expect(change().hasAttribute('disabled')).toBe(false);
  });

  it('reports a wrong current password and closes after a change', async () => {
    mock.api.changePassword.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderWithVaultProviders(<ChangeMasterPasswordDialog open onOpenChange={onOpenChange} />);
    fill('wrong password here', STRONG);
    fireEvent.click(change());
    expect((await screen.findByRole('alert')).textContent).toMatch(/current password/i);

    fill('right password here', STRONG);
    fireEvent.click(change());
    await waitFor(() =>
      expect(mock.api.changePassword).toHaveBeenLastCalledWith('right password here', STRONG),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalled();
  });

  it('changes to a recovery phrase made for it, once the phrase is checked (E107)', async () => {
    mock.api.changePassword.mockResolvedValueOnce(true);
    renderWithVaultProviders(<ChangeMasterPasswordDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'right password here' },
    });
    expect(change().hasAttribute('disabled')).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: /I saved it/ }));
    for (let i = 0; i < 3; i++) {
      const asked = Number(
        screen.getByText(/^Which is word \d+\?$/).textContent?.match(/\d+/)?.[0],
      );
      fireEvent.click(screen.getByRole('button', { name: MOCK_PHRASE_WORDS[asked - 1] }));
    }
    fireEvent.click(change());

    await waitFor(() =>
      expect(mock.api.changePassword).toHaveBeenCalledWith('right password here', {
        phraseId: MOCK_PHRASE_ID,
      }),
    );
  });
});
