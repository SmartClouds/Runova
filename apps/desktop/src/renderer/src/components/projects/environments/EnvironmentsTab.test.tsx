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
