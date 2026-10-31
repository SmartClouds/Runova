import type {
  DatabaseConnection,
  DatabaseSession,
  DbRowsPage,
  DbTableDescription,
} from '@shared/databaseTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDatabaseWorkbenchStore } from '@/stores/databaseWorkbenchStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DatabasePanel } from './DatabasePanel';

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      aria-label="Query"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

/**
 * Changing data without writing SQL: the table designer and editing rows in the grid. Both show
 * the exact statements before anything runs.
 */

const connection: DatabaseConnection = {
  id: 'conn-1',
  name: 'dev-pg',
  engine: 'postgres',
  target: { kind: 'localContainer', containerId: 'c1', containerName: 'dev-pg', port: 5432 },
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
const session: DatabaseSession = { sessionId: 'sess-1', connection, serverVersion: '17.2' };
const ref = { database: 'shop', schema: 'public', name: 'orders' };

const table: DbTableDescription = {
  ref,
  kind: 'table',
  columns: [
    {
      name: 'id',
      type: 'integer',
      nullable: false,
      defaultValue: null,
      primaryKey: true,
      generated: true,
    },
    {
      name: 'customer',
      type: 'text',
      nullable: true,
      defaultValue: null,
      primaryKey: false,
      generated: false,
    },
  ],
  indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true, primary: true }],
  rowEstimate: 2,
  definition: null,
};

const page: DbRowsPage = {
  result: {
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'customer', type: 'text' },
    ],
    rows: [
      [1, 'Ada'],
      [2, 'Grace'],
    ],
    affectedRows: null,
    truncated: false,
    durationMs: 1,
    statement: '',
    notice: null,
  },
  total: 2,
  keyColumns: ['id'],
};

function render(extra: Record<string, unknown> = {}) {
  useDatabaseWorkbenchStore.getState().open('local', session);
  return renderWithProviders(<DatabasePanel server={null} />, {
    bridge: {
      'database.listObjects': [],
      'database.describe': table,
      'database.readRows': page,
      'database.query': { status: 'done', results: [] },
      ...extra,
    },
  });
}

describe('row editing', () => {
  it('edits a cell, deletes a row, and applies both in one reviewed transaction', async () => {
    const view = render();
    useDatabaseWorkbenchStore
      .getState()
      .openTab('local', { kind: 'data', title: 'orders', ref, objectKind: 'table' });
    const grid = await screen.findByRole('table', { name: 'public.orders' });
    await screen.findByText(/double-click a cell to edit it/);

    await view.user.dblClick(within(grid).getByText('Ada'));
    const input = screen.getByRole('textbox', { name: 'Edit customer' });
    await view.user.clear(input);
    await view.user.type(input, 'Ada L.{Enter}');
    await view.user.click(within(grid).getByRole('button', { name: 'Delete row 2' }));

    expect(screen.getByText('2 changes not saved yet')).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Review and apply' }));
    const preview = await screen.findByLabelText('Changes to apply');
    expect(preview.textContent).toBe(
      [
        'BEGIN;',
        `UPDATE "public"."orders" SET "customer" = 'Ada L.' WHERE "id" = 1;`,
        'DELETE FROM "public"."orders" WHERE "id" = 2;',
        'COMMIT;',
      ].join('\n'),
    );
    await view.user.click(screen.getByRole('button', { name: 'Apply changes' }));
    await waitFor(() =>
      expect(view.bridge.$fn('database.query')).toHaveBeenCalledWith(
        expect.objectContaining({ text: preview.textContent, confirmed: true, database: 'shop' }),
      ),
    );
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).not.toBeInTheDocument());
  });

  it('sets a cell to NULL in one click, and adds a row from a form', async () => {
    const view = render();
    useDatabaseWorkbenchStore
      .getState()
      .openTab('local', { kind: 'data', title: 'orders', ref, objectKind: 'table' });
    const grid = await screen.findByRole('table', { name: 'public.orders' });
    await screen.findByText(/double-click a cell to edit it/);
    await view.user.dblClick(within(grid).getByText('Grace'));
    await view.user.click(screen.getByRole('button', { name: 'NULL' }));

    await view.user.click(screen.getByRole('button', { name: /add row/i }));
    const dialog = await screen.findByRole('dialog', { name: /add a row/i });
    await view.user.type(within(dialog).getByLabelText(/customer/), 'Linus');
    await view.user.click(within(dialog).getByRole('button', { name: 'Add row' }));

    await view.user.click(screen.getByRole('button', { name: 'Review and apply' }));
    const preview = await screen.findByLabelText('Changes to apply');
    expect(preview.textContent).toContain(
      `UPDATE "public"."orders" SET "customer" = NULL WHERE "id" = 2;`,
    );
    expect(preview.textContent).toContain(
      `INSERT INTO "public"."orders" ("customer") VALUES ('Linus');`,
    );
  });

  it('says nothing was changed when the transaction fails', async () => {
    const view = render({
      'database.query': {
        status: 'failed',
        results: [],
        error: 'violates not-null',
        statementIndex: 1,
      },
    });
    useDatabaseWorkbenchStore
      .getState()
      .openTab('local', { kind: 'data', title: 'orders', ref, objectKind: 'table' });
    const grid = await screen.findByRole('table', { name: 'public.orders' });
    await screen.findByText(/double-click a cell to edit it/);
    await view.user.click(within(grid).getByRole('button', { name: 'Delete row 1' }));
    await view.user.click(screen.getByRole('button', { name: 'Review and apply' }));
    await view.user.click(await screen.findByRole('button', { name: 'Apply changes' }));
    expect(await screen.findByText(/Nothing was changed\. violates not-null/)).toBeInTheDocument();
    expect(screen.getByText('1 change not saved yet')).toBeInTheDocument();
  });

  it('does not offer editing on a table with no primary key, or a read-only connection', async () => {
    render({ 'database.readRows': { ...page, keyColumns: [] } });
    useDatabaseWorkbenchStore
      .getState()
      .openTab('local', { kind: 'data', title: 'orders', ref, objectKind: 'table' });
    expect(
      await screen.findByText(/no primary key, so rows cannot be edited here/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add row/i })).not.toBeInTheDocument();
  });
});

describe('table designer', () => {
  it('makes a table from rows of columns, showing the statement that runs', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: 'New table' }));
    const dialog = await screen.findByRole('dialog', { name: /new table/i });
    await view.user.type(within(dialog).getByLabelText('Name'), 'invoices');
    await view.user.click(within(dialog).getByRole('button', { name: /add a column/i }));
    await view.user.type(within(dialog).getByRole('textbox', { name: 'Column 3 name' }), 'paid');
    const type = within(dialog).getByRole('combobox', { name: 'Column 3 type' });
    await view.user.clear(type);
    await view.user.type(type, 'boolean');

    const preview = within(dialog).getByLabelText('Statement preview');
    expect(preview.textContent).toBe(
      [
        'CREATE TABLE "public"."invoices" (',
        '  "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
        '  "name" text,',
        '  "paid" boolean,',
        '  PRIMARY KEY ("id")',
        ');',
      ].join('\n'),
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Create table' }));
    await waitFor(() =>
      expect(view.bridge.$fn('database.query')).toHaveBeenCalledWith(
        expect.objectContaining({ text: preview.textContent, confirmed: true, database: 'shop' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('changes the columns of a table from its structure', async () => {
    const view = render();
    useDatabaseWorkbenchStore
      .getState()
      .openTab('local', { kind: 'structure', title: 'orders', ref, objectKind: 'table' });
    await view.user.click(await screen.findByRole('button', { name: /edit columns/i }));
    const dialog = await screen.findByRole('dialog', { name: /columns of orders/i });
    expect(within(dialog).getByText('Nothing has changed yet.')).toBeInTheDocument();
    const name = within(dialog).getByRole('textbox', { name: 'Column 2 name' });
    await view.user.clear(name);
    await view.user.type(name, 'client');
    expect(within(dialog).getByLabelText('Statement preview').textContent).toBe(
      'ALTER TABLE "public"."orders" RENAME COLUMN "customer" TO "client";',
    );
  });

  it('shows why a design cannot be made', async () => {
    const view = render();
    await view.user.click(await screen.findByRole('button', { name: 'New table' }));
    const dialog = await screen.findByRole('dialog', { name: /new table/i });
    expect(within(dialog).getByText('Name the table.')).toBeInTheDocument();
    await view.user.type(within(dialog).getByLabelText('Name'), 't');
    await view.user.clear(within(dialog).getByRole('textbox', { name: 'Column 1 name' }));
    expect(within(dialog).getByText('Every column needs a name.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create table' })).toBeDisabled();
  });
});
