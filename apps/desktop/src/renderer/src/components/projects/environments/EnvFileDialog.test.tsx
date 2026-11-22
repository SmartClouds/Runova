import type { EnvFileSummary, ProjectEnvironment } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

const { EnvFileDialog } = await import('./EnvFileDialog');
const { toast } = await import('sonner');

/** Editing a saved env file, and what a save does when the file is linked to a project file. */

function envFile(overrides: Partial<EnvFileSummary> = {}): EnvFileSummary {
  return {
    id: 'f1',
    fileName: '.env.prod',
    keyCount: 1,
    origin: 'edited',
    updatedAt: Date.now(),
    versionCount: 0,
    ...overrides,
  };
}

function renderDialog(file: EnvFileSummary) {
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
  return renderWithProviders(
    <EnvFileDialog
      open
      onOpenChange={vi.fn()}
      environment={environment}
      file={file}
      onSaved={vi.fn()}
    />,
    {
      bridge: {
        'environments.readFile': () => Promise.resolve('A=1\n'),
        'environments.saveFile': environment,
      },
    },
  );
}

describe('EnvFileDialog', () => {
  it('says a save stays in Runova when the file is not linked', async () => {
    renderDialog(envFile());
    await screen.findByText('A=1');
    expect(
      screen.getByText('Saved encrypted in Runova. Nothing is written to the project folder.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save file' })).toBeInTheDocument();
  });

  it('says a save writes the linked project file too', async () => {
    const { user, bridge } = renderDialog(
      envFile({ link: { path: 'apps/api/.env.prod', state: 'watching' } }),
    );
    await screen.findByText('A=1');
    expect(
      screen.getByText('Linked to apps/api/.env.prod. Saving also writes that file.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save and write file' }));
    await waitFor(() => expect(bridge.$fn('environments.saveFile')).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(
      '.env.prod saved and written to apps/api/.env.prod.',
    );
  });
});
