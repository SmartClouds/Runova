import type { DbEngine } from '@runova/core';
import type {
  DatabaseConnection,
  DatabaseSession,
  DbHealthReport,
  DbSchemaGraph,
} from '@shared/databaseTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDatabaseWorkbenchStore } from '@/stores/databaseWorkbenchStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DatabasePanel } from './DatabasePanel';

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: () => <textarea aria-label="Query" />,
}));

/**
 * Where the diagram and index health open from: the workbench header, a database or schema in
 * the tree, and a table's structure. Engines without them show no button.
 */

function connection(engine: DbEngine): DatabaseConnection {
  return {
    id: 'conn-1',
    name: 'shop-db',
    engine,
    target: { kind: 'direct', host: 'db', port: 5432 },
    user: 'app',
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
}

const graph: DbSchemaGraph = {
  database: 'shop',
  schema: null,
  totalTables: 1,
  truncated: false,
  tables: [
    {
      ref: { database: 'shop', schema: 'public', name: 'orders' },
      kind: 'table',
      rowEstimate: 3,
      columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
    },
  ],
  relations: [],
};

const health: DbHealthReport = {
  database: 'shop',
  measuredAt: '2026-11-15T10:00:00.000Z',
  method: 'planner statistics (estimate)',
  precise: false,
  canBePrecise: false,
  onlineRebuild: false,
  indexes: [],
  tables: [],
  totalBytes: 8_000_000,
  freeBytes: null,
  notes: [],
};

function render(engine: DbEngine) {
  const session: DatabaseSession = {
    sessionId: 'sess-1',
    connection: connection(engine),
    serverVersion: '17',
  };
  useDatabaseWorkbenchStore.getState().open('local', session);
  return renderWithProviders(<DatabasePanel server={null} />, {
    bridge: {
      'database.listObjects': async (input: { parent: unknown; parentKind: string | null }) =>
        input.parent === null
          ? [
              {
                kind: 'database',
                name: 'shop',
                ref: { database: 'shop', name: 'shop' },
                hasChildren: true,
                rowEstimate: null,
              },
            ]
          : input.parentKind === 'database'
            ? [
                {
                  kind: 'schema',
                  name: 'public',
                  ref: { database: 'shop', schema: 'public', name: 'public' },
                  hasChildren: true,
                  rowEstimate: null,
                },
              ]
            : [
                {
                  kind: 'table',
                  name: 'orders',
                  ref: { database: 'shop', schema: 'public', name: 'orders' },
                  hasChildren: false,
                  rowEstimate: 3,
                },
              ],
      'database.schemaGraph': graph,
      'database.readRows': {
        result: {
          columns: [{ name: 'id', type: 'integer' }],
          rows: [[1]],
          affectedRows: null,
          truncated: false,
          durationMs: 1,
          statement: 'SELECT',
          notice: null,
        },
        total: 1,
        keyColumns: ['id'],
      },
      'database.health': health,
      'database.describe': {
        ref: { database: 'shop', schema: 'public', name: 'orders' },
        kind: 'table',
        columns: [],
        indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true, primary: true }],
        rowEstimate: 3,
        definition: null,
      },
    },
  });
}

describe('diagram and index health in the workbench', () => {
  it('opens both from the header for the database in use', async () => {
    const view = render('postgres');
    await view.user.click(await screen.findByRole('button', { name: 'Diagram' }));
    expect(await screen.findByRole('tab', { name: /Diagram · shop/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(view.bridge.$fn('database.schemaGraph')).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      database: 'shop',
      schema: null,
    });
    await view.user.click(screen.getByRole('button', { name: 'Index health' }));
    expect(await screen.findByRole('tab', { name: /Health · shop/ })).toBeInTheDocument();
    expect(view.bridge.$fn('database.health')).toHaveBeenCalled();
  });

  it('opens a schema diagram from the tree, and the table opens from it', async () => {
    const view = render('postgres');
    await view.user.click(await screen.findByRole('button', { name: 'Expand shop' }));
    const schema = await screen.findByRole('treeitem', { name: 'public' });
    await view.user.click(within(schema).getByRole('button', { name: 'Diagram of public' }));
    expect(view.bridge.$fn('database.schemaGraph')).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      database: 'shop',
      schema: 'public',
    });
    const card = await screen.findByRole('button', { name: /^orders table/ });
    card.focus();
    await view.user.keyboard('{Enter}');
    expect(await screen.findByRole('tab', { name: /^orders/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens index health from a database in the tree', async () => {
    const view = render('mysql');
    const database = await screen.findByRole('treeitem', { name: 'shop' });
    await view.user.click(within(database).getByRole('button', { name: 'Index health of shop' }));
    expect(view.bridge.$fn('database.health')).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      database: 'shop',
      schema: null,
      scan: 'fast',
    });
  });

  it('links a table structure to the index health of its database', async () => {
    const view = render('postgres');
    await view.user.click(await screen.findByRole('button', { name: 'Expand shop' }));
    await view.user.click(await screen.findByRole('button', { name: 'Expand public' }));
    const table = await screen.findByRole('treeitem', { name: 'orders' });
    await view.user.click(within(table).getByRole('button', { name: 'Structure of orders' }));
    await view.user.click(await screen.findByRole('button', { name: 'See index health' }));
    expect(await screen.findByRole('tab', { name: /Health · shop/ })).toBeInTheDocument();
  });

  it('shows neither for engines without them', async () => {
    render('redis');
    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Diagram' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Index health' })).toBeNull();
  });
});
