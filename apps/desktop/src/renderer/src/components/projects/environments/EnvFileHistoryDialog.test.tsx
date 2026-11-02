import type { EnvFileSummary, EnvFileVersionSummary, ProjectEnvironment } from '@shared/apiTypes';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

// Monaco needs workers and layout jsdom does not have. These show what each editor was handed.
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value }: { value: string }) => <pre data-testid="full-file">{value}</pre>,
}));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  MonacoDiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="diff">
      <pre data-testid="diff-original">{original}</pre>
      <pre data-testid="diff-modified">{modified}</pre>
    </div>
  ),
}));

const { EnvFileHistoryDialog } = await import('./EnvFileHistoryDialog');

/**
 * The history of one env file: the versions it had before each save, compared with what is saved
 * now, and a way to put one back. Values are secrets, so the summary names keys only.
 */

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const file: EnvFileSummary = {
  id: 'f1',
  fileName: '.env.production',
  keyCount: 3,
  origin: 'edited',
  updatedAt: NOW - HOUR,
  versionCount: 2,
};

const environment: ProjectEnvironment = {
  id: 'e1',
  projectId: 'p1',
  name: 'Production',
  kind: 'production',
  order: 0,
  files: [file],
  credentials: [],
  createdAt: NOW - 100 * HOUR,
  updatedAt: NOW - HOUR,
};

const newer: EnvFileVersionSummary = {
  id: 'v2',
  fileName: '.env.production',
  keyCount: 3,
  origin: 'imported',
  savedAt: NOW - 48 * HOUR,
  replacedAt: NOW - HOUR,
};

const older: EnvFileVersionSummary = {
  id: 'v1',
  fileName: '.env',
  keyCount: 1,
  savedAt: NOW - 96 * HOUR,
  replacedAt: NOW - 48 * HOUR,
};

const CURRENT = 'A=1\nB=two\nD=4\n';
const CONTENTS: Record<string, string> = {
  v2: 'A=1\nB=2\nC=3\n',
  v1: 'A=1\n',
};

function renderDialog(
  overrides: {
    history?: EnvFileVersionSummary[];
    bridge?: Record<string, unknown>;
    queryClient?: QueryClient;
  } = {},
) {
  const onRestored = vi.fn();
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <EnvFileHistoryDialog
      open
      onOpenChange={onOpenChange}
      environment={environment}
      file={file}
      onRestored={onRestored}
    />,
    {
      bridge: {
        'environments.fileHistory': overrides.history ?? [newer, older],
        'environments.readFile': () => Promise.resolve(CURRENT),
        'environments.readFileVersion': (_e: string, _f: string, versionId: string) =>
          Promise.resolve(CONTENTS[versionId]),
        'environments.restoreFileVersion': environment,
        ...overrides.bridge,
      },
      queryClient: overrides.queryClient,
    },
  );
  return { ...view, onRestored, onOpenChange };
}

function options(): HTMLElement[] {
  return within(screen.getByRole('listbox', { name: 'Versions' })).getAllByRole('option');
}

describe('EnvFileHistoryDialog', () => {
  it('lists the current file first, then each earlier version newest first', async () => {
    renderDialog();

    await waitFor(() => expect(options()).toHaveLength(3));
    const [current, second, third] = options();
    expect(current).toHaveTextContent('Current');
    expect(current).toHaveTextContent('Edited');
    expect(second).toHaveTextContent('Imported from folder');
    expect(second).toHaveTextContent('3 keys');
    // A version saved before history existed has no origin, and this one had another name.
    expect(third).toHaveTextContent('Saved');
    expect(third).toHaveTextContent('1 key');
    expect(third).toHaveTextContent('was .env');
    expect(screen.getByText(/Production · 2 earlier versions/)).toBeInTheDocument();
  });

  it('opens on the newest earlier version, compared with the current file', async () => {
    renderDialog();

    await waitFor(() => expect(options()[1]).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByTestId('diff-original')).toHaveTextContent('C=3');
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('D=4');
    // Key names only: what changed since this version, never the values.
    const summary = screen.getByRole('list', { name: 'Keys changed since this version' });
    expect(within(summary).getByText('D')).toBeInTheDocument();
    expect(within(summary).getByText('C')).toBeInTheDocument();
    expect(within(summary).getByText('B')).toBeInTheDocument();
    expect(summary).not.toHaveTextContent('two');
    expect(screen.getByText('1 added · 1 removed · 1 changed')).toBeInTheDocument();
  });

  it('shows a whole version on request', async () => {
    const { user } = renderDialog();
    await screen.findByTestId('diff');

    await user.click(screen.getByRole('button', { name: 'Full file' }));
    expect(screen.getByTestId('full-file')).toHaveTextContent('C=3');
    expect(screen.queryByTestId('diff')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full file' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('moves through the versions with the arrow keys', async () => {
    const { user } = renderDialog();
    await waitFor(() => expect(options()[1]).toHaveAttribute('aria-selected', 'true'));

    options()[1].focus();
    await user.keyboard('{ArrowDown}');
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('diff-original')).toHaveTextContent(/^A=1$/);

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('cannot restore the current file onto itself', async () => {
    const { user } = renderDialog();
    await waitFor(() => expect(options()).toHaveLength(3));

    await user.click(options()[0]);
    expect(screen.getByText('This is the file as it is saved now.')).toBeInTheDocument();
    expect(screen.getByTestId('full-file')).toHaveTextContent('D=4');
    expect(screen.getByRole('button', { name: /Restore this version/ })).toBeDisabled();
  });

  it('says so when a version matches the current file, and offers no restore', async () => {
    renderDialog({
      bridge: { 'environments.readFileVersion': () => Promise.resolve(CURRENT) },
    });

    expect(await screen.findByText('Identical to the current file.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore this version/ })).toBeDisabled();
  });

  it('restores a version after a confirm, and says the current one is kept', async () => {
    const { user, bridge, onRestored } = renderDialog();
    await screen.findByTestId('diff');

    await user.click(screen.getByRole('button', { name: /Restore this version/ }));

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: 'Restore',
        description: expect.stringContaining('kept in the history'),
      }),
    );
    await waitFor(() =>
      expect(bridge.$fn('environments.restoreFileVersion')).toHaveBeenCalledWith('e1', 'f1', 'v2'),
    );
    expect(onRestored).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('.env.production restored'));
    // The history is read again, and the view moves to the file as it is now.
    await waitFor(() => expect(bridge.$fn('environments.fileHistory')).toHaveBeenCalledTimes(2));
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the file name when restoring a version saved under another one', async () => {
    const { user } = renderDialog();
    await waitFor(() => expect(options()).toHaveLength(3));
    await user.click(options()[2]);
    await screen.findByText(/^A=1$/);

    confirm.mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: /Restore this version/ }));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('keeps its name, .env.production'),
      }),
    );
  });

  it('does nothing when the confirm is turned down', async () => {
    const restoreFileVersion = vi.fn(async () => environment);
    const { user, onRestored } = renderDialog({
      bridge: { 'environments.restoreFileVersion': restoreFileVersion },
    });
    await screen.findByTestId('diff');
    confirm.mockResolvedValueOnce(false);

    await user.click(screen.getByRole('button', { name: /Restore this version/ }));
    expect(confirm).toHaveBeenCalled();
    expect(restoreFileVersion).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('shows what went wrong when a restore fails', async () => {
    const { user, onRestored } = renderDialog({
      bridge: {
        'environments.restoreFileVersion': () =>
          Promise.reject(new Error('That version is no longer in the history.')),
      },
    });
    await screen.findByTestId('diff');

    await user.click(screen.getByRole('button', { name: /Restore this version/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That version is no longer in the history.'),
    );
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('shows what went wrong when a version cannot be read', async () => {
    renderDialog({
      bridge: {
        'environments.readFileVersion': () => Promise.reject(new Error('The vault is locked.')),
      },
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The vault is locked.'));
    // The preview says so too, rather than loading forever.
    expect(await screen.findByText('Could not open this version.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore this version/ })).toBeDisabled();
  });

  it('reads the history again each time it opens, even within the app cache time', async () => {
    // The app keeps queries fresh for 30 seconds. A save made just before opening the history
    // must still show up, so this list never comes from that cache.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    queryClient.setQueryData(['env-file-history', 'f1'], [older]);
    renderDialog({ queryClient });

    await waitFor(() => expect(options()).toHaveLength(3));
  });

  it('explains how history fills up when there is none yet', async () => {
    renderDialog({ history: [] });

    expect(await screen.findByText('No earlier versions yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Each time you save, import over, rename or restore this file/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore this version/ })).not.toBeInTheDocument();
  });
});
