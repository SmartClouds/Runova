import type { DbObjectRef, DbRelation, DbSchemaGraph } from '@shared/databaseTypes';

/**
 * Turns a schema graph into what the diagram draws: one card per table (with a faded stub for a
 * table in another schema that a key points at), and one link per foreign key, with the rows the
 * line starts and ends on. Card sizes are worked out from the text, since SVG cannot wrap.
 */

export const CARD = {
  header: 36,
  row: 22,
  padding: 8,
  minWidth: 180,
  maxWidth: 320,
} as const;

/** Rough widths of the card fonts, close enough to size a card without measuring. */
const NAME_CHAR = 7.4;
const COLUMN_CHAR = 6.6;
const TYPE_CHAR = 6;

export interface DiagramColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  foreignKey: boolean;
}

export interface DiagramCard {
  id: string;
  ref: DbObjectRef;
  name: string;
  schema: string | null;
  rowEstimate: number | null;
  columns: DiagramColumn[];
  /** Columns left out in keys-only mode. */
  hiddenColumns: number;
  /** A table outside what was read, drawn faded so the line has somewhere to go. */
  stub: boolean;
  width: number;
  height: number;
}

export interface DiagramLink {
  id: string;
  relation: DbRelation;
  from: string;
  to: string;
  /** The row of the first key column on each card, or -1 to aim at the header. */
  fromRow: number;
  toRow: number;
  /** A key column that can be null: the row does not have to point anywhere. */
  optional: boolean;
}

export interface Diagram {
  cards: DiagramCard[];
  links: DiagramLink[];
}

export function tableKey(ref: DbObjectRef): string {
  return JSON.stringify([ref.database ?? null, ref.schema ?? null, ref.name]);
}

function sizeOf(
  name: string,
  columns: DiagramColumn[],
  hidden: number,
): { width: number; height: number } {
  const lines = columns.map(
    (column) => 30 + column.name.length * COLUMN_CHAR + 18 + column.type.length * TYPE_CHAR + 12,
  );
  const wanted = Math.max(28 + name.length * NAME_CHAR + 60, ...lines);
  const rows = columns.length + (hidden > 0 ? 1 : 0);
  return {
    width: Math.round(Math.min(CARD.maxWidth, Math.max(CARD.minWidth, wanted))),
    height: CARD.header + rows * CARD.row + CARD.padding,
  };
}

export function buildDiagram(graph: DbSchemaGraph, options: { keysOnly: boolean }): Diagram {
  const keyColumns = new Map<string, Set<string>>();
  for (const relation of graph.relations) {
    const id = tableKey(relation.from.ref);
    const set = keyColumns.get(id) ?? new Set<string>();
    for (const column of relation.from.columns) set.add(column);
    keyColumns.set(id, set);
  }

  const cards: DiagramCard[] = graph.tables.map((table) => {
    const id = tableKey(table.ref);
    const foreign = keyColumns.get(id) ?? new Set<string>();
    const all = table.columns.map((column) => ({
      ...column,
      foreignKey: foreign.has(column.name),
    }));
    const columns = options.keysOnly
      ? all.filter((column) => column.primaryKey || column.foreignKey)
      : all;
    const hiddenColumns = all.length - columns.length;
    return {
      id,
      ref: table.ref,
      name: table.ref.name,
      schema: table.ref.schema ?? null,
      rowEstimate: table.rowEstimate,
      columns,
      hiddenColumns,
      stub: false,
      ...sizeOf(table.ref.name, columns, hiddenColumns),
    };
  });

  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const relation of graph.relations) {
    const id = tableKey(relation.to.ref);
    if (byId.has(id)) continue;
    const columns = relation.to.columns.map((name) => ({
      name,
      type: '',
      nullable: false,
      primaryKey: false,
      foreignKey: false,
    }));
    const card: DiagramCard = {
      id,
      ref: relation.to.ref,
      name: relation.to.ref.name,
      schema: relation.to.ref.schema ?? null,
      rowEstimate: null,
      columns,
      hiddenColumns: 0,
      stub: true,
      ...sizeOf(relation.to.ref.name, columns, 0),
    };
    cards.push(card);
    byId.set(id, card);
  }

  const rowOf = (card: DiagramCard | undefined, names: string[]) =>
    card ? card.columns.findIndex((column) => column.name === names[0]) : -1;
  const links = graph.relations.flatMap((relation, index): DiagramLink[] => {
    const from = byId.get(tableKey(relation.from.ref));
    const to = byId.get(tableKey(relation.to.ref));
    if (!from || !to) return [];
    const source = graph.tables.find((table) => tableKey(table.ref) === from.id);
    return [
      {
        id: `${index}:${relation.name}`,
        relation,
        from: from.id,
        to: to.id,
        fromRow: rowOf(from, relation.from.columns),
        toRow: rowOf(to, relation.to.columns),
        optional: relation.from.columns.some(
          (name) => source?.columns.find((column) => column.name === name)?.nullable ?? false,
        ),
      },
    ];
  });
  return { cards, links };
}

/** A table and every table one foreign key away from it, either way. */
export function relatedTo(diagram: Diagram, id: string): Set<string> {
  const related = new Set([id]);
  for (const link of diagram.links) {
    if (link.from === id) related.add(link.to);
    if (link.to === id) related.add(link.from);
  }
  return related;
}

/** The y of a card's row centre, or of its header when the row is not shown. */
export function rowY(y: number, row: number): number {
  if (row < 0) return y + CARD.header / 2;
  return y + CARD.header + row * CARD.row + CARD.row / 2;
}
