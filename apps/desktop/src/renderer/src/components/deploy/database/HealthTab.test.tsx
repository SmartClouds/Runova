import type { DbEngine } from '@runova/core';
import type { DbHealthReport } from '@shared/databaseTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { HealthTab } from './HealthTab';

/**
 * Index health: fragmentation per index with the engine's advice, the clean-ups it offers, the
 * statements shown before anything runs, and nothing to run on a read-only connection.
 */

const orders = { database: 'Shop', schema: 'dbo', name: 'Orders' };

const mssqlReport: DbHealthReport = {
  database: 'Shop',
  measuredAt: '2026-11-15T10:42:00.000Z',
  method: 'sys.dm_db_index_physical_stats, LIMITED',
  precise: true,
  canBePrecise: false,
  onlineRebuild: true,
  totalBytes: 104_857_600,
  freeBytes: 52_428_800,
  notes: [],
  indexes: [
    {
      table: orders,
      name: 'PK_Orders',
      type: 'clustered',
      columns: ['Id'],
      unique: true,
      primary: true,
      sizeBytes: 5000 * 8192,
      pageCount: 5000,
      fragmentationPercent: 41.2,
    },
    {
      table: orders,
      name: 'IX_Orders_Placed',
      type: 'nonclustered',
      columns: ['PlacedAt', 'State'],
      unique: false,
      primary: false,
      sizeBytes: 1500 * 8192,
      pageCount: 1500,
      fragmentationPercent: 12,
    },
    {
      table: { database: 'Shop', schema: 'dbo', name: 'Log' },
      name: null,
      type: 'heap',
      columns: [],
      unique: false,
      primary: false,
      sizeBytes: 20 * 8192,
      pageCount: 20,
      fragmentationPercent: 3,
    },
  ],
  tables: [
    {
      table: orders,
      rowEstimate: 90_000,
      dataBytes: 40_960_000,
      indexBytes: 12_288_000,
      freeBytes: 819_200,
      freePercent: 1.5,
    },
  ],
};

function renderHealth(
  report: DbHealthReport | (() => Promise<DbHealthReport>) = mssqlReport,
  { engine = 'mssql', readOnly = false }: { engine?: DbEngine; readOnly?: boolean } = {},
) {
  return renderWithProviders(
    <HealthTab
      sessionId="s1"
      engine={engine}
      readOnly={readOnly}
      scope={{ database: 'Shop', schema: null }}
    />,
    {
      bridge: {
        'database.health': typeof report === 'function' ? report : async () => report,
        'database.query': async () => ({ status: 'done', results: [] }),
      },
    },
  );
}

const row = (name: RegExp) => screen.getByRole('row', { name });

describe('HealthTab', () => {
  it('lists each index with its fragmentation and what to do about it', async () => {
    const view = renderHealth();
    const pk = await screen.findByRole('row', { name: /PK_Orders/ });
    expect(within(pk).getByText('Clustered')).toBeInTheDocument();
    expect(within(pk).getByText('41.2%')).toBeInTheDocument();
    expect(within(pk).getByText('Rebuild advised')).toBeInTheDocument();
    expect(within(row(/IX_Orders_Placed/)).getByText('Reorganize advised')).toBeInTheDocument();
    expect(within(row(/IX_Orders_Placed/)).getByText('PlacedAt, State')).toBeInTheDocument();
    expect(within(row(/Heap/)).getByText('Too small')).toBeInTheDocument();
    expect(screen.getByText(/sys\.dm_db_index_physical_stats, LIMITED/)).toBeInTheDocument();
    const attention = screen.getByRole('group', { name: 'Need attention' });
    expect(within(attention).getByText('2')).toBeInTheDocument();
    expect(view.bridge.$fn('database.health')).toHaveBeenCalledWith({
      sessionId: 's1',
      database: 'Shop',
      schema: null,
      scan: 'fast',
    });
  });

  it('filters to the indexes that need attention, and by kind', async () => {
    const view = renderHealth();
    await screen.findByRole('row', { name: /PK_Orders/ });
    await view.user.click(screen.getByRole('button', { name: /Needs attention/ }));
    expect(screen.queryByRole('row', { name: /Heap/ })).toBeNull();
    expect(row(/PK_Orders/)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: /^Nonclustered/ }));
    expect(screen.queryByRole('row', { name: /PK_Orders/ })).toBeNull();
    expect(row(/IX_Orders_Placed/)).toBeInTheDocument();
  });

  it('shows the rebuild statement with its options before running it, then rescans', async () => {
    const view = renderHealth();
    await screen.findByRole('row', { name: /PK_Orders/ });
    await view.user.click(screen.getByRole('button', { name: 'Rebuild PK_Orders' }));
    const dialog = await screen.findByRole('dialog');
    const preview = within(dialog).getByLabelText('Statements to run');
    expect(preview).toHaveTextContent(
      'ALTER INDEX [PK_Orders] ON [Shop].[dbo].[Orders] REBUILD WITH (ONLINE = ON);',
    );
    await view.user.click(within(dialog).getByRole('checkbox', { name: /Online/ }));
    await view.user.type(within(dialog).getByRole('spinbutton', { name: /Fill factor/ }), '90');
    expect(preview).toHaveTextContent(
      'ALTER INDEX [PK_Orders] ON [Shop].[dbo].[Orders] REBUILD WITH (FILLFACTOR = 90);',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(view.bridge.$fn('database.query')).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        database: 'Shop',
        confirmed: true,
        text: 'ALTER INDEX [PK_Orders] ON [Shop].[dbo].[Orders] REBUILD WITH (FILLFACTOR = 90);',
      }),
    );
    await waitFor(() => expect(view.bridge.$fn('database.health')).toHaveBeenCalledTimes(2));
  });

  it('says why online rebuilds are off on editions without them', async () => {
    const view = renderHealth({ ...mssqlReport, onlineRebuild: false });
    await screen.findByRole('row', { name: /PK_Orders/ });
    await view.user.click(screen.getByRole('button', { name: 'Rebuild PK_Orders' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: /Online/ })).toBeDisabled();
    expect(within(dialog).getByText(/Enterprise or Developer/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Statements to run')).toHaveTextContent(
      'ALTER INDEX [PK_Orders] ON [Shop].[dbo].[Orders] REBUILD;',
    );
  });

  it('fixes the selected indexes in one go, each its own way', async () => {
    const view = renderHealth();
    await screen.findByRole('row', { name: /PK_Orders/ });
    await view.user.click(screen.getByRole('checkbox', { name: 'Select PK_Orders' }));
    await view.user.click(screen.getByRole('checkbox', { name: 'Select IX_Orders_Placed' }));
    await view.user.click(screen.getByRole('button', { name: 'Fix 2 indexes' }));
    const preview = within(await screen.findByRole('dialog')).getByLabelText('Statements to run');
    expect(preview).toHaveTextContent('ALTER INDEX [PK_Orders] ON [Shop].[dbo].[Orders] REBUILD');
    expect(preview).toHaveTextContent(
      'ALTER INDEX [IX_Orders_Placed] ON [Shop].[dbo].[Orders] REORGANIZE;',
    );
  });

  it('selects every index that needs attention at once', async () => {
    const view = renderHealth();
    await screen.findByRole('row', { name: /PK_Orders/ });
    await view.user.click(
      screen.getByRole('checkbox', { name: 'Select every index that needs attention' }),
    );
    expect(screen.getByRole('button', { name: 'Fix 2 indexes' })).toBeInTheDocument();
  });

  it('runs nothing on a read-only connection', async () => {
    renderHealth(mssqlReport, { readOnly: true });
    await screen.findByRole('row', { name: /PK_Orders/ });
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebuild PK_Orders' })).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: 'Select PK_Orders' })).toBeNull();
  });

  it('rescans thoroughly when asked', async () => {
    const view = renderHealth();
    await screen.findByRole('row', { name: /PK_Orders/ });
    await view.user.click(screen.getByRole('button', { name: 'Thorough' }));
    await waitFor(() =>
      expect(view.bridge.$fn('database.health')).toHaveBeenLastCalledWith(
        expect.objectContaining({ scan: 'thorough' }),
      ),
    );
  });

  it('offers exact numbers on PostgreSQL with pgstattuple', async () => {
    const view = renderHealth(
      {
        ...mssqlReport,
        method: 'planner statistics (estimate)',
        precise: false,
        canBePrecise: true,
        onlineRebuild: false,
        indexes: [
          {
            table: { database: 'shop', schema: 'public', name: 'orders' },
            name: 'orders_pkey',
            type: 'btree',
            columns: ['id'],
            unique: true,
            primary: true,
            sizeBytes: 40_000_000,
            pageCount: 4883,
            fragmentationPercent: 48,
          },
        ],
        tables: [],
      },
      { engine: 'postgres' },
    );
    await screen.findByRole('row', { name: /orders_pkey/ });
    expect(screen.getByText(/estimates/i)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Add pgstattuple' }));
    expect(
      within(await screen.findByRole('dialog')).getByLabelText('Statements to run'),
    ).toHaveTextContent('CREATE EXTENSION IF NOT EXISTS pgstattuple;');
    await view.user.click(screen.getByRole('button', { name: 'Cancel' }));
    await view.user.click(screen.getByRole('button', { name: 'Reindex orders_pkey' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Statements to run')).toHaveTextContent(
      'REINDEX INDEX CONCURRENTLY "public"."orders_pkey";',
    );
  });

  it('measures MySQL by table and optimizes the table', async () => {
    const view = renderHealth(
      {
        ...mssqlReport,
        database: 'shop',
        method: 'information_schema',
        onlineRebuild: false,
        indexes: [
          {
            table: { database: 'shop', name: 'orders' },
            name: 'PRIMARY',
            type: 'clustered',
            columns: ['id'],
            unique: true,
            primary: true,
            sizeBytes: null,
            pageCount: null,
            fragmentationPercent: null,
          },
        ],
        tables: [
          {
            table: { database: 'shop', name: 'orders' },
            rowEstimate: 1000,
            dataBytes: 30_000_000,
            indexBytes: 10_000_000,
            freeBytes: 10_000_000,
            freePercent: 20,
          },
        ],
      },
      { engine: 'mysql' },
    );
    expect(
      within(await screen.findByRole('row', { name: /PRIMARY/ })).getByText('By table'),
    ).toBeInTheDocument();
    const table = row(/orders.*20%/);
    await view.user.click(within(table).getByRole('button', { name: 'Optimize orders' }));
    expect(
      within(await screen.findByRole('dialog')).getByLabelText('Statements to run'),
    ).toHaveTextContent('OPTIMIZE TABLE `shop`.`orders`;');
  });

  it('shows why it could not measure, with a way to try again', async () => {
    let calls = 0;
    const view = renderHealth(async () => {
      calls += 1;
      if (calls === 1)
        throw new Error('Reading fragmentation needs the VIEW DATABASE STATE permission.');
      return mssqlReport;
    });
    expect(await screen.findByText(/VIEW DATABASE STATE/)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('row', { name: /PK_Orders/ })).toBeInTheDocument();
  });
});
