import type { DbSchemaGraph } from '@shared/databaseTypes';
import { describe, expect, it } from 'vitest';
import { buildDiagram, CARD, relatedTo, tableKey } from './diagramModel';

const ref = (name: string, schema = 'public') => ({ database: 'shop', schema, name });

const graph: DbSchemaGraph = {
  database: 'shop',
  schema: 'public',
  totalTables: 3,
  truncated: false,
  tables: [
    {
      ref: ref('customers'),
      kind: 'table',
      rowEstimate: 10,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: false, primaryKey: false },
      ],
    },
    {
      ref: ref('orders'),
      kind: 'table',
      rowEstimate: 100,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'customer_id', type: 'integer', nullable: true, primaryKey: false },
        { name: 'placed_by', type: 'integer', nullable: false, primaryKey: false },
        { name: 'note', type: 'character varying(2000)', nullable: true, primaryKey: false },
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
      name: 'orders_placed_by_fk',
      from: { ref: ref('orders'), columns: ['placed_by'] },
      to: { ref: ref('users', 'auth'), columns: ['id'] },
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
    },
  ],
};

describe('buildDiagram', () => {
  it('makes a card per table with its columns and marks keys', () => {
    const diagram = buildDiagram(graph, { keysOnly: false });
    const orders = diagram.cards.find((card) => card.name === 'orders');
    expect(
      orders?.columns.map((column) => [column.name, column.primaryKey, column.foreignKey]),
    ).toEqual([
      ['id', true, false],
      ['customer_id', false, true],
      ['placed_by', false, true],
      ['note', false, false],
    ]);
    expect(orders?.height).toBe(CARD.header + 4 * CARD.row + CARD.padding);
    expect(orders?.width).toBeGreaterThanOrEqual(CARD.minWidth);
    expect(orders?.width).toBeLessThanOrEqual(CARD.maxWidth);
  });

  it('adds a faded stub for a table in another schema that a key points at', () => {
    const diagram = buildDiagram(graph, { keysOnly: false });
    const stub = diagram.cards.find((card) => card.name === 'users');
    expect(stub).toMatchObject({ stub: true, schema: 'auth', columns: [{ name: 'id' }] });
    expect(diagram.links).toHaveLength(2);
    expect(diagram.links[1]).toMatchObject({
      from: tableKey(ref('orders')),
      to: tableKey(ref('users', 'auth')),
    });
  });

  it('keeps only key columns when asked, and counts the rest', () => {
    const diagram = buildDiagram(graph, { keysOnly: true });
    const orders = diagram.cards.find((card) => card.name === 'orders');
    expect(orders?.columns.map((column) => column.name)).toEqual([
      'id',
      'customer_id',
      'placed_by',
    ]);
    expect(orders?.hiddenColumns).toBe(1);
    expect(orders?.height).toBe(CARD.header + 4 * CARD.row + CARD.padding);
    const settings = diagram.cards.find((card) => card.name === 'settings');
    expect(settings?.columns).toEqual([]);
    expect(settings?.hiddenColumns).toBe(1);
  });

  it('marks a relation optional when a key column can be null', () => {
    const diagram = buildDiagram(graph, { keysOnly: false });
    expect(diagram.links.map((link) => link.optional)).toEqual([true, false]);
  });

  it('finds the row of each end of a relation', () => {
    const diagram = buildDiagram(graph, { keysOnly: false });
    expect(diagram.links[0]).toMatchObject({ fromRow: 1, toRow: 0 });
  });
});

describe('relatedTo', () => {
  it('gives a table, the tables it points at and the tables that point at it', () => {
    const diagram = buildDiagram(graph, { keysOnly: false });
    expect([...relatedTo(diagram, tableKey(ref('customers')))].sort()).toEqual(
      [tableKey(ref('customers')), tableKey(ref('orders'))].sort(),
    );
    expect(relatedTo(diagram, tableKey(ref('settings'))).size).toBe(1);
  });
});
