import type { DbSchemaGraph } from '@shared/databaseTypes';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { DiagramTab } from './DiagramTab';

/**
 * The entity relationship diagram: a card per table, a line per foreign key, search, keys only,
 * a details panel for the picked table, and opening a table's rows from its card.
 */

const ref = (name: string, schema = 'public') => ({ database: 'shop', schema, name });

const graph: DbSchemaGraph = {
  database: 'shop',
  schema: null,
  totalTables: 3,
  truncated: false,
  tables: [
    {
      ref: ref('customers'),
      kind: 'table',
      rowEstimate: 10,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'email', type: 'text', nullable: false, primaryKey: false },
      ],
    },
    {
      ref: ref('orders'),
      kind: 'table',
      rowEstimate: 1200,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'customer_id', type: 'integer', nullable: true, primaryKey: false },
        { name: 'note', type: 'text', nullable: true, primaryKey: false },
      ],
    },
    {
      ref: ref('settings'),
      kind: 'table',
      rowEstimate: 1,
      columns: [{ name: 'value', type: 'jsonb', nullable: true, primaryKey: false }],
    },
  ],
  relations: [
    {
      name: 'orders_customer_fk',
      from: { ref: ref('orders'), columns: ['customer_id'] },
      to: { ref: ref('customers'), columns: ['id'] },
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION',
    },
    {
      name: 'orders_auditor_fk',
      from: { ref: ref('orders'), columns: ['id'] },
      to: { ref: ref('audit', 'logs'), columns: ['order_id'] },
      onDelete: null,
      onUpdate: null,
    },
  ],
};

function renderDiagram(answer: DbSchemaGraph | (() => Promise<DbSchemaGraph>) = graph) {
  const onOpenRows = vi.fn();
  const onOpenStructure = vi.fn();
  const onPositionsChange = vi.fn();
  const view = renderWithProviders(
    <DiagramTab
      sessionId="s1"
      scope={{ database: 'shop', schema: null }}
      positions={undefined}
      onPositionsChange={onPositionsChange}
      onOpenRows={onOpenRows}
      onOpenStructure={onOpenStructure}
    />,
    {
      bridge: {
        'database.schemaGraph': typeof answer === 'function' ? answer : async () => answer,
      },
    },
  );
  return { ...view, onOpenRows, onOpenStructure, onPositionsChange };
}

const card = (name: RegExp) => screen.getByRole('button', { name });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiagramTab', () => {
  it('draws a card per table and a line per foreign key', async () => {
    const view = renderDiagram();
    expect(await screen.findByRole('button', { name: /^orders table/ })).toBeInTheDocument();
    expect(card(/^customers table/)).toBeInTheDocument();
    expect(card(/^settings table/)).toBeInTheDocument();
    expect(screen.getByText('3 tables · 2 relationships')).toBeInTheDocument();
    expect(
      screen.getByText(/orders\.customer_id → customers\.id.*ON DELETE CASCADE/),
    ).toBeInTheDocument();
    expect(view.bridge.$fn('database.schemaGraph')).toHaveBeenCalledWith({
      sessionId: 's1',
      database: 'shop',
      schema: null,
    });
  });

  it('shows a table in another schema as a stub that does not open', async () => {
    const { onOpenRows } = renderDiagram();
    const stub = await screen.findByRole('button', { name: /^logs\.audit, in another schema/ });
    fireEvent.doubleClick(stub);
    expect(onOpenRows).not.toHaveBeenCalled();
  });

  it('hides the columns that are not keys', async () => {
    const view = renderDiagram();
    const orders = await screen.findByRole('button', { name: /^orders table/ });
    expect(within(orders).getByText('note')).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Keys only' }));
    expect(within(card(/^orders table/)).queryByText('note')).toBeNull();
    expect(within(card(/^orders table/)).getByText('+1 more column')).toBeInTheDocument();
  });

  it('dims tables that do not match the search, and Enter picks the first match', async () => {
    const view = renderDiagram();
    await screen.findByRole('button', { name: /^orders table/ });
    const search = screen.getByRole('searchbox', { name: 'Find a table' });
    await view.user.type(search, 'cust');
    expect(card(/^customers table/)).toHaveAttribute('data-dimmed', 'false');
    expect(card(/^settings table/)).toHaveAttribute('data-dimmed', 'true');
    await view.user.keyboard('{Enter}');
    const details = screen.getByRole('complementary', { name: 'customers' });
    expect(within(details).getByText('Referenced by')).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'orders' })).toBeInTheDocument();
  });

  it('says when nothing matches the search', async () => {
    const view = renderDiagram();
    await screen.findByRole('button', { name: /^orders table/ });
    await view.user.type(screen.getByRole('searchbox', { name: 'Find a table' }), 'zzz');
    expect(screen.getByText('No table matches “zzz”.')).toBeInTheDocument();
  });

  it('opens a table from its card and from the details panel', async () => {
    const view = renderDiagram();
    const orders = await screen.findByRole('button', { name: /^orders table/ });
    fireEvent.doubleClick(orders);
    expect(view.onOpenRows).toHaveBeenCalledWith(ref('orders'));
    orders.focus();
    fireEvent.keyDown(orders, { key: 'Enter' });
    expect(view.onOpenRows).toHaveBeenCalledTimes(2);
    fireEvent.click(orders);
    const details = screen.getByRole('complementary', { name: 'orders' });
    expect(within(details).getByText('References')).toBeInTheDocument();
    await view.user.click(within(details).getByRole('button', { name: 'Structure' }));
    expect(view.onOpenStructure).toHaveBeenCalledWith(ref('orders'));
    await view.user.click(within(details).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'orders' })).toBeNull();
  });

  it('zooms in and out within bounds', async () => {
    const view = renderDiagram();
    await screen.findByRole('button', { name: /^orders table/ });
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const before = screen.getByRole('button', { name: /Fit to screen/ }).textContent;
    await view.user.click(zoomIn);
    expect(screen.getByRole('button', { name: /Fit to screen/ }).textContent).not.toBe(before);
    for (let i = 0; i < 20; i++) await view.user.click(zoomIn);
    expect(screen.getByRole('button', { name: /Fit to screen/ })).toHaveTextContent('200%');
  });

  it('exports the diagram as SVG', async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:diagram';
    });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const view = renderDiagram();
    await screen.findByRole('button', { name: /^orders table/ });
    await view.user.click(screen.getByRole('button', { name: 'Export as SVG' }));
    expect(click).toHaveBeenCalled();
    expect(created[0]?.type).toBe('image/svg+xml');
    expect(await created[0]?.text()).toMatch(/^<svg[\s\S]*customers/);
  });

  it('says when the database has no tables yet', async () => {
    renderDiagram({ ...graph, tables: [], relations: [], totalTables: 0 });
    expect(await screen.findByText('No tables here yet')).toBeInTheDocument();
  });

  it('says when the diagram was cut short', async () => {
    renderDiagram({ ...graph, totalTables: 950, truncated: true });
    expect(await screen.findByText(/Showing 3 of 950 tables/)).toBeInTheDocument();
  });

  it('shows a failure with a way to try again', async () => {
    let calls = 0;
    const view = renderDiagram(async () => {
      calls += 1;
      if (calls === 1) throw new Error('permission denied for schema sales');
      return graph;
    });
    expect(await screen.findByText(/permission denied for schema sales/)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(card(/^orders table/)).toBeInTheDocument());
  });
});
