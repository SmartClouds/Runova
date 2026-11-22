import type { EnvFolderFile, ProjectEnvironment } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const { ImportEnvFilesDialog } = await import('./ImportEnvFilesDialog');

/** Importing the .env files in the project root, linked to where they came from by default. */

const production: ProjectEnvironment = {
  id: 'e1',
  projectId: 'p1',
  name: 'Production',
  kind: 'production',
  order: 0,
  files: [],
  credentials: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const found: EnvFolderFile = {
  fileName: '.env.production',
  size: 64,
  guessedKind: 'production',
  isTemplate: false,
  tooLarge: false,
};

function renderDialog() {
  return renderWithProviders(
    <ImportEnvFilesDialog
      open
      onOpenChange={vi.fn()}
      projectId="p1"
      environments={[production]}
      onImported={vi.fn()}
    />,
    {
      bridge: {
        'environments.scanFolder': [found],
        'environments.importFromFolder': { imported: 1, errors: [] },
      },
    },
  );
}

describe('ImportEnvFilesDialog', () => {
  it('links the imported copies to their files unless told not to', async () => {
    const { user, bridge } = renderDialog();
    const keepLinked = await screen.findByRole('checkbox', {
      name: 'Keep the copies linked to these files',
    });
    expect(keepLinked).toBeChecked();

    await user.click(screen.getByRole('button', { name: /^Import/ }));
    await waitFor(() =>
      expect(bridge.$fn('environments.importFromFolder')).toHaveBeenCalledWith('p1', [
        { fileName: '.env.production', environmentId: 'e1', link: true },
      ]),
    );
  });

  it('imports plain copies when linking is turned off', async () => {
    const { user, bridge } = renderDialog();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Keep the copies linked to these files' }),
    );

    await user.click(screen.getByRole('button', { name: /^Import/ }));
    await waitFor(() =>
      expect(bridge.$fn('environments.importFromFolder')).toHaveBeenCalledWith('p1', [
        { fileName: '.env.production', environmentId: 'e1', link: false },
      ]),
    );
  });
});
