import type { DatabaseConnection } from '@shared/databaseTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BackupsTab, formatBytes } from './BackupsTab';

/** Backups with the engine's own tool, and a restore that wants the database's name typed out. */

const connection: DatabaseConnection = {
  id: 'conn-1',
  name: 'shop-db',
  engine: 'postgres',
  target: { kind: 'localContainer', containerId: 'c1', containerName: 'shop-db', port: 5432 },
  user: 'postgres',
  database: 'shop',
  authDatabase: null,
  tls: false,
  srv: false,
  readOnly: false,
  hasPassword: true,
  locked: false,
  createdAt: 1,
  lastUsedAt: null,
};

const file = {
  name: 'shop-db-2026-11-01-102030.dump',
  size: 2_400_000,
  createdAt: 1,
  complete: true,
};

describe('BackupsTab', () => {
  it('says which tool runs where, and backs up in one click', async () => {
    const backup = vi.fn(async () => file);
    const view = renderWithProviders(<BackupsTab connection={connection} />, {
      bridge: { 'database.listBackups': [], 'database.backup': backup },
    });
    expect(
      await screen.findByText(/Runs pg_dump inside shop-db in Docker here/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/No backups yet/)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: /back up now/i }));
    expect(backup).toHaveBeenCalledWith('conn-1');
    expect(
      await screen.findByText(/Saved shop-db-2026-11-01-102030\.dump \(2\.3 MB\)/),
    ).toBeInTheDocument();
  });

  it('shows the tool error when a backup fails', async () => {
    const view = renderWithProviders(<BackupsTab connection={connection} />, {
      bridge: {
        'database.listBackups': [],
        'database.backup': async () => {
          throw new Error('The backup failed: pg_dump: error: server version mismatch');
        },
      },
    });
    await view.user.click(await screen.findByRole('button', { name: /back up now/i }));
    expect(await screen.findByText(/server version mismatch/)).toBeInTheDocument();
  });

  it('restores only after the database name is typed', async () => {
    const restore = vi.fn(async () => undefined);
    const view = renderWithProviders(<BackupsTab connection={connection} />, {
      bridge: { 'database.listBackups': [file], 'database.restore': restore },
    });
    await screen.findByText(file.name);
    const list = screen.getByRole('list', { name: 'Backups' });
    await view.user.click(within(list).getByRole('button', { name: /restore/i }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Restore' });
    expect(confirm).toBeDisabled();
    await view.user.type(within(dialog).getByLabelText(/type shop to restore/i), 'shop');
    await view.user.click(confirm);
    await waitFor(() => expect(restore).toHaveBeenCalledWith('conn-1', file.name));
    expect(await screen.findByText(`Restored ${file.name}.`)).toBeInTheDocument();
  });

  it('explains why a direct connection has no backups here', () => {
    renderWithProviders(
      <BackupsTab
        connection={{ ...connection, target: { kind: 'direct', host: 'db', port: 5432 } }}
      />,
    );
    expect(
      screen.getByText(/need the database in a container or on a server/i),
    ).toBeInTheDocument();
  });

  it('tells how to restore Redis, which loads snapshots only at start', async () => {
    renderWithProviders(<BackupsTab connection={{ ...connection, engine: 'redis' }} />, {
      bridge: { 'database.listBackups': [file] },
    });
    expect(await screen.findByText(/copy the file into its data folder/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^restore$/i })).not.toBeInTheDocument();
  });
});

describe('formatBytes', () => {
  it('writes sizes people read', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
});
