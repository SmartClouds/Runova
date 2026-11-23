import type { EnvFileSummary, ProjectEnvironment } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { project } from '../../health/testing/fixtures';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value }: { value: string }) => <pre>{value}</pre>,
}));
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  MonacoDiffEditor: () => <div />,
}));

const { EnvironmentsTab } = await import('./EnvironmentsTab');

/** The Environments tab's file rows: how much history each file has, and the way into it. */

function envFile(overrides: Partial<EnvFileSummary>): EnvFileSummary {
  return {
    id: 'f1',
    fileName: '.env.production',
    keyCount: 3,
    origin: 'edited',
    updatedAt: Date.now(),
    versionCount: 0,
    ...overrides,
  };
}

const environment: ProjectEnvironment = {
  id: 'e1',
  projectId: 'p1',
  name: 'Production',
  kind: 'production',
  order: 0,
  files: [
    envFile({ id: 'f1', fileName: '.env.production', versionCount: 3 }),
    envFile({ id: 'f2', fileName: '.env', versionCount: 1 }),
    envFile({ id: 'f3', fileName: '.env.local', versionCount: 0 }),
  ],
  credentials: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function row(fileName: string): HTMLElement {
  const name = screen.getByText(fileName, { selector: 'p' });
  const item = name.closest('li');
  if (!item) throw new Error(`No row for ${fileName}`);
  return item;
}

function renderTab(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<EnvironmentsTab project={project({ id: 'p1' })} />, {
    bridge: {
      'environments.list': [environment],
      'environments.fileHistory': [],
      'environments.readFile': () => Promise.resolve('A=1\n'),
      ...bridge,
    },
  });
}

describe('EnvironmentsTab file history', () => {
  it('says how many earlier versions each file keeps', async () => {
    renderTab();

    await screen.findByText('.env.production', { selector: 'p' });
    expect(row('.env.production')).toHaveTextContent('3 earlier versions');
    expect(row('.env')).toHaveTextContent('1 earlier version');
    expect(row('.env')).not.toHaveTextContent('versions');
    expect(row('.env.local')).not.toHaveTextContent('earlier');
  });

  it("opens a file's history from its row", async () => {
    const { user, bridge } = renderTab();
    await screen.findByText('.env.production', { selector: 'p' });

    await user.click(within(row('.env')).getByRole('button', { name: 'History' }));

    expect(await screen.findByRole('dialog', { name: 'History of .env' })).toBeInTheDocument();
    await waitFor(() =>
      expect(bridge.$fn('environments.fileHistory')).toHaveBeenCalledWith('e1', 'f2'),
    );
  });

  it('asks to unlock the vault first when it is locked', async () => {
    const { user } = renderTab({ 'ssh.vaultStatus': { hasPasskey: true, unlocked: false } });
    await screen.findByText('.env.production', { selector: 'p' });

    await user.click(within(row('.env.production')).getByRole('button', { name: 'History' }));

    expect(await screen.findByRole('dialog')).not.toHaveAccessibleName(/^History of/);
  });
});

describe('EnvironmentsTab linked files', () => {
  const linkedEnvironment: ProjectEnvironment = {
    ...environment,
    files: [
      envFile({
        id: 'f1',
        fileName: '.env.production',
        origin: 'fileChanged',
        link: { path: 'apps/api/.env.prod', state: 'watching' },
      }),
      envFile({ id: 'f2', fileName: '.env', link: { path: '.env', state: 'missing' } }),
      envFile({
        id: 'f3',
        fileName: '.env.local',
        link: { path: '.env.local', state: 'waitingForUnlock' },
      }),
      envFile({ id: 'f4', fileName: '.env.test' }),
    ],
  };

  function renderLinked(bridge: Record<string, unknown> = {}) {
    return renderTab({ 'environments.list': [linkedEnvironment], ...bridge });
  }

  it('shows which project file each linked copy follows, and how that is going', async () => {
    renderLinked();
    await screen.findByText('.env.production', { selector: 'p' });

    expect(row('.env.production')).toHaveTextContent('apps/api/.env.prod');
    expect(row('.env.production')).toHaveTextContent('Watching for changes');
    expect(row('.env.production')).toHaveTextContent('updated from the file');
    expect(row('.env')).toHaveTextContent('File not found, showing the last saved copy');
    expect(row('.env.local')).toHaveTextContent('Locked, unlock to pick up changes');
    expect(within(row('.env.local')).getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    expect(row('.env.test')).not.toHaveTextContent('Watching');
  });

  it('offers a link on unlinked rows, and drops the folder write on linked ones', async () => {
    renderLinked();
    await screen.findByText('.env.production', { selector: 'p' });

    expect(
      within(row('.env.test')).getByRole('button', { name: 'Link to a project file' }),
    ).toBeInTheDocument();
    expect(
      within(row('.env.test')).getByRole('button', { name: /to the project folder/ }),
    ).toBeInTheDocument();
    // A linked copy already writes its file on every save.
    expect(
      within(row('.env.production')).queryByRole('button', { name: /to the project folder/ }),
    ).toBeNull();
    expect(
      within(row('.env.production')).queryByRole('button', { name: 'Link to a project file' }),
    ).toBeNull();
  });

  it('opens the link dialog from an unlinked row', async () => {
    const { user } = renderLinked({ 'environments.scanFolder': [] });
    await screen.findByText('.env.test', { selector: 'p' });

    await user.click(
      within(row('.env.test')).getByRole('button', { name: 'Link to a project file' }),
    );

    expect(
      await screen.findByRole('dialog', { name: 'Link .env.test to a project file' }),
    ).toBeInTheDocument();
  });

  it('asks to confirm a link that came from another computer, starting on its file', async () => {
    const synced: ProjectEnvironment = {
      ...environment,
      files: [
        envFile({
          id: 'f9',
          fileName: '.env.shared',
          link: { path: 'config/.env.shared', state: 'needsConfirmation' },
        }),
      ],
    };
    const { user } = renderTab({
      'environments.list': [synced],
      'environments.scanFolder': [],
      'environments.inspectLinkFile': {
        path: 'config/.env.shared',
        keyCount: 1,
        sameAsSaved: true,
      },
    });
    await screen.findByText('.env.shared', { selector: 'p' });
    expect(row('.env.shared')).toHaveTextContent('Not followed here until you confirm it');

    await user.click(within(row('.env.shared')).getByRole('button', { name: 'Review link' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Link .env.shared to a project file',
    });
    expect(within(dialog).getByRole('radio', { name: /config\/\.env\.shared/ })).toBeChecked();
  });

  it('unlinks and shows the file in its folder from the link menu', async () => {
    const { user, bridge } = renderLinked();
    await screen.findByText('.env.production', { selector: 'p' });

    await user.click(within(row('.env.production')).getByRole('button', { name: 'Linked file' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Show in folder' }));
    expect(bridge.$fn('explorer.revealInOs')).toHaveBeenCalledWith(
      'p1',
      String.raw`C:\work\storefront\apps\api\.env.prod`,
    );

    await user.click(within(row('.env.production')).getByRole('button', { name: 'Linked file' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unlink' }));
    await waitFor(() =>
      expect(bridge.$fn('environments.unlinkFile')).toHaveBeenCalledWith('e1', 'f1'),
    );
  });

  it('refetches when a linked file changes this project on disk', async () => {
    const { bridge } = renderLinked();
    await screen.findByText('.env.production', { selector: 'p' });
    const list = bridge.$fn('environments.list');
    const before = list.mock.calls.length;

    bridge.$emit('environments.onChanged', { projectId: 'other' });
    bridge.$emit('environments.onChanged', { projectId: 'p1' });

    await waitFor(() => expect(list.mock.calls.length).toBe(before + 1));
  });

  it('lights up a row its file just changed, then lets it go even when the list comes again', async () => {
    const before = envFile({ id: 'f1', origin: 'linked', updatedAt: 1_000 });
    const after = envFile({ id: 'f1', origin: 'fileChanged', updatedAt: 2_000, keyCount: 4 });
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ ...environment, files: [before] }])
      .mockResolvedValue([{ ...environment, files: [after] }]);
    const { bridge } = renderTab({ 'environments.list': list });
    await screen.findByText('.env.production', { selector: 'p' });
    expect(row('.env.production')).not.toHaveClass('bg-primary/15');

    bridge.$emit('environments.onChanged', { projectId: 'p1' });
    await waitFor(() => expect(row('.env.production')).toHaveClass('bg-primary/15'));
    // A second refetch while it is lit, which used to keep the highlight on for good.
    bridge.$emit('environments.onChanged', { projectId: 'p1' });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));

    await waitFor(() => expect(row('.env.production')).not.toHaveClass('bg-primary/15'), {
      timeout: 5_000,
    });
  });
});
