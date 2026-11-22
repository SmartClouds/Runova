import type { EnvFileSummary, EnvFolderFile, ProjectEnvironment } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { LinkEnvFileDialog } = await import('./LinkEnvFileDialog');
const { toast } = await import('sonner');

/** Linking a saved env file to a file in the project: picking it, seeing what happens, linking. */

const file: EnvFileSummary = {
  id: 'f1',
  fileName: '.env.prod',
  keyCount: 2,
  origin: 'edited',
  updatedAt: Date.now(),
  versionCount: 0,
};

const environment: ProjectEnvironment = {
  id: 'e1',
  projectId: 'p1',
  name: 'Production',
  kind: 'production',
  order: 0,
  files: [file],
  credentials: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function folderFile(fileName: string, overrides: Partial<EnvFolderFile> = {}): EnvFolderFile {
  return {
    fileName,
    size: 120,
    guessedKind: 'production',
    isTemplate: false,
    tooLarge: false,
    ...overrides,
  };
}

function renderDialog(bridge: Record<string, unknown> = {}) {
  const onLinked = vi.fn();
  const onOpenChange = vi.fn();
  const rendered = renderWithProviders(
    <LinkEnvFileDialog
      open
      onOpenChange={onOpenChange}
      projectId="p1"
      environment={environment}
      file={file}
      onLinked={onLinked}
    />,
    {
      bridge: {
        'environments.scanFolder': [
          folderFile('.env'),
          folderFile('.env.example', { isTemplate: true }),
          folderFile('.env.prod'),
        ],
        'environments.inspectLinkFile': (_e: string, _f: string, path: string) =>
          Promise.resolve({ path, keyCount: 4, sameAsSaved: false }),
        'environments.linkFile': environment,
        ...bridge,
      },
    },
  );
  return { ...rendered, onLinked, onOpenChange };
}

describe('LinkEnvFileDialog', () => {
  it('suggests the env files in the project root, starting with the one of the same name', async () => {
    const { bridge } = renderDialog();

    expect(
      screen.getByRole('dialog', { name: 'Link .env.prod to a project file' }),
    ).toBeInTheDocument();
    const choice = await screen.findByRole('radio', { name: '.env.prod' });
    expect(choice).toBeChecked();
    expect(screen.getByRole('radio', { name: '.env' })).not.toBeChecked();
    await waitFor(() =>
      expect(bridge.$fn('environments.inspectLinkFile')).toHaveBeenCalledWith(
        'e1',
        'f1',
        '.env.prod',
      ),
    );
  });

  it('says what linking will do to the saved copy before it happens', async () => {
    renderDialog();
    expect(await screen.findByText(/4 keys/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "This copy takes the file's contents now. What it holds today stays in History.",
      ),
    ).toBeInTheDocument();
  });

  it('says nothing changes when the file already matches', async () => {
    renderDialog({
      'environments.inspectLinkFile': (_e: string, _f: string, path: string) =>
        Promise.resolve({ path, keyCount: 2, sameAsSaved: true }),
    });
    expect(
      await screen.findByText('Same contents as the saved copy, so no new version is added.'),
    ).toBeInTheDocument();
  });

  it('links the chosen file and closes', async () => {
    const { user, bridge, onLinked, onOpenChange } = renderDialog();
    await user.click(await screen.findByRole('radio', { name: '.env' }));
    await screen.findByText(/4 keys/);

    await user.click(screen.getByRole('button', { name: 'Link file' }));

    await waitFor(() =>
      expect(bridge.$fn('environments.linkFile')).toHaveBeenCalledWith({
        environmentId: 'e1',
        fileId: 'f1',
        path: '.env',
      }),
    );
    expect(onLinked).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('.env.prod now follows .env.');
  });

  it('can pick any file in the project, and keeps the choice when the picker is cancelled', async () => {
    const { user, bridge } = renderDialog({
      'environments.pickLinkFile': vi
        .fn()
        .mockResolvedValueOnce('apps/api/.env.prod')
        .mockResolvedValueOnce(null),
    });
    await screen.findByRole('radio', { name: '.env.prod' });

    await user.click(screen.getByRole('button', { name: 'Choose another file...' }));
    const picked = await screen.findByRole('radio', { name: 'apps/api/.env.prod' });
    expect(picked).toBeChecked();
    expect(bridge.$fn('environments.pickLinkFile')).toHaveBeenCalledWith('p1');

    await user.click(screen.getByRole('button', { name: 'Choose another file...' }));
    await waitFor(() => expect(bridge.$fn('environments.pickLinkFile')).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('radio', { name: 'apps/api/.env.prod' })).toBeChecked();
  });

  it('shows why a file cannot be linked and keeps the button off', async () => {
    renderDialog({
      'environments.inspectLinkFile': () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'environments:inspectLinkFile': Error: That file is larger than 1 MB.",
          ),
        ),
    });
    expect(await screen.findByText(/That file is larger than 1 MB\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link file' })).toBeDisabled();
  });

  it('points to the picker when the project root has no env files', async () => {
    renderDialog({ 'environments.scanFolder': [] });
    expect(
      await screen.findByText(
        'No .env files in the project root. Choose any file in the project instead.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link file' })).toBeDisabled();
  });
});
