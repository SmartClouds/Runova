/**
 * Lays out an entity relationship diagram without a graph library. Each group of related tables
 * gets layers by foreign key direction, so a table sits to the right of the tables it points at.
 * Each layer is ordered to cut down crossings, and the groups are packed onto shelves, the biggest
 * group first and lone tables last. The same input always gives the same picture.
 */

export interface DiagramNode {
  id: string;
  width: number;
  height: number;
}

/** A foreign key: `from` holds the key and points at `to`. */
export interface DiagramEdge {
  from: string;
  to: string;
}

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface DiagramBox extends DiagramPoint {
  width: number;
  height: number;
}

export interface DiagramLayout {
  positions: Record<string, DiagramPoint>;
  width: number;
  height: number;
}

export interface DiagramSpacing {
  /** Between layers. Wide enough for the relation lines. */
  columnGap: number;
  /** Between tables in one layer. */
  rowGap: number;
  /** Between groups of tables. */
  groupGap: number;
}

const SPACING: DiagramSpacing = { columnGap: 96, rowGap: 32, groupGap: 96 };
const SWEEPS = 6;

interface Placed {
  ids: string[];
  positions: Map<string, DiagramPoint>;
  width: number;
  height: number;
}

export function layoutDiagram(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  spacing: Partial<DiagramSpacing> = {},
): DiagramLayout {
  const gaps = { ...SPACING, ...spacing };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const known = edges.filter(
    (edge) => edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to),
  );

  const neighbours = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set()]));
  for (const edge of known) {
    neighbours.get(edge.from)?.add(edge.to);
    neighbours.get(edge.to)?.add(edge.from);
  }

  const groups = components(nodes, neighbours);
  const placed = groups.map((ids) => placeGroup(ids, known, byId, order, neighbours, gaps));
  return pack(placed, gaps);
}

function components(
  nodes: readonly DiagramNode[],
  neighbours: Map<string, Set<string>>,
): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const group: string[] = [];
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      group.push(id);
      for (const next of neighbours.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    groups.push(group);
  }
  // Biggest group first, then the order the tables came in. Stable sort keeps ties in place.
  return groups.sort((a, b) => b.length - a.length);
}

/** Layer 0 holds tables that point at nothing; each other table sits right of what it points at. */
function layers(
  ids: string[],
  edges: readonly DiagramEdge[],
  order: Map<string, number>,
): Map<string, number> {
  const inGroup = new Set(ids);
  const parents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (inGroup.has(edge.from)) parents.get(edge.from)?.push(edge.to);
  }
  for (const list of parents.values()) {
    list.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  const rank = new Map<string, number>();
  const onStack = new Set<string>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    onStack.add(id);
    let value = 0;
    for (const parent of parents.get(id) ?? []) {
      // A parent still on the stack closes a cycle: that edge is ignored for layering.
      if (onStack.has(parent)) continue;
      value = Math.max(value, visit(parent) + 1);
    }
    onStack.delete(id);
    rank.set(id, value);
    return value;
  };
  for (const id of ids) visit(id);
  return rank;
}

function placeGroup(
  ids: string[],
  edges: readonly DiagramEdge[],
  byId: Map<string, DiagramNode>,
  order: Map<string, number>,
  neighbours: Map<string, Set<string>>,
  gaps: DiagramSpacing,
): Placed {
  const rank = layers(ids, edges, order);
  const count = Math.max(...ids.map((id) => rank.get(id) ?? 0)) + 1;
  const columns: string[][] = Array.from({ length: count }, () => []);
  for (const id of [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
    columns[rank.get(id) ?? 0]?.push(id);
  }

  // Barycenter sweeps, left to right and back, to keep related tables level with each other.
  const slot = new Map<string, number>();
  const remember = () => {
    for (const column of columns) for (const [index, id] of column.entries()) slot.set(id, index);
  };
  remember();
  const sortBy = (column: string[], side: string[]) => {
    const sideSet = new Set(side);
    const weight = new Map<string, number>();
    for (const id of column) {
      const near = [...(neighbours.get(id) ?? [])].filter((other) => sideSet.has(other));
      weight.set(
        id,
        near.length === 0
          ? (slot.get(id) ?? 0)
          : near.reduce((sum, other) => sum + (slot.get(other) ?? 0), 0) / near.length,
      );
    }
    column.sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0));
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (let index = 1; index < columns.length; index++) {
      sortBy(columns[index] as string[], columns[index - 1] as string[]);
      remember();
    }
    for (let index = columns.length - 2; index >= 0; index--) {
      sortBy(columns[index] as string[], columns[index + 1] as string[]);
      remember();
    }
  }

  const size = (id: string) => byId.get(id) as DiagramNode;
  const columnHeight = (column: string[]) =>
    column.reduce((sum, id) => sum + size(id).height, 0) + gaps.rowGap * (column.length - 1);
  const height = Math.max(...columns.map(columnHeight));
  const positions = new Map<string, DiagramPoint>();
  let x = 0;
  for (const column of columns) {
    const width = Math.max(...column.map((id) => size(id).width));
    let y = Math.round((height - columnHeight(column)) / 2);
    for (const id of column) {
      positions.set(id, { x, y });
      y += size(id).height + gaps.rowGap;
    }
    x += width + gaps.columnGap;
  }
  return { ids, positions, width: x - gaps.columnGap, height };
}

/** Puts groups on shelves, left to right, starting a new shelf when one gets too wide. */
function pack(groups: Placed[], gaps: DiagramSpacing): DiagramLayout {
  const area = groups.reduce((sum, group) => sum + group.width * group.height, 0);
  const widest = Math.max(0, ...groups.map((group) => group.width));
  const limit = Math.max(widest, Math.round(Math.sqrt(area) * 1.6));

  const positions: Record<string, DiagramPoint> = {};
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 0;
  for (const group of groups) {
    if (x > 0 && x + group.width > limit) {
      x = 0;
      y += shelf + gaps.groupGap;
      shelf = 0;
    }
    for (const id of group.ids) {
      const at = group.positions.get(id) as DiagramPoint;
      positions[id] = { x: at.x + x, y: at.y + y };
    }
    width = Math.max(width, x + group.width);
    shelf = Math.max(shelf, group.height);
    x += group.width + gaps.groupGap;
  }
  return { positions, width, height: groups.length > 0 ? y + shelf : 0 };
}

export interface RelationEnd extends DiagramPoint {
  /** Which way the line leaves the card: 1 to the right, -1 to the left. */
  dir: 1 | -1;
}

export interface RelationPath {
  /** An SVG path from the key column to the column it points at. */
  d: string;
  start: RelationEnd;
  end: RelationEnd;
}

/**
 * The line from a foreign key's row (at `fromY`) to the row it points at (at `toY`). It leaves the
 * side that faces the other card, or loops out on the right when the cards are stacked.
 */
export function relationPath(
  from: DiagramBox,
  fromY: number,
  to: DiagramBox,
  toY: number,
): RelationPath {
  let startDir: 1 | -1 = 1;
  let endDir: 1 | -1 = 1;
  if (from.x + from.width < to.x) {
    endDir = -1;
  } else if (to.x + to.width < from.x) {
    startDir = -1;
  }
  const start: RelationEnd = {
    x: startDir === 1 ? from.x + from.width : from.x,
    y: fromY,
    dir: startDir,
  };
  const end: RelationEnd = { x: endDir === 1 ? to.x + to.width : to.x, y: toY, dir: endDir };
  const round = (value: number) => Math.round(value * 10) / 10;
  let c1x: number;
  let c2x: number;
  if (startDir === endDir) {
    // Stacked cards: both ends leave on the right and the line bows out past the wider one.
    c1x = Math.max(start.x, end.x) + 56;
    c2x = c1x;
  } else {
    const reach = Math.max(40, Math.abs(end.x - start.x) / 2);
    c1x = start.x + startDir * reach;
    c2x = end.x + endDir * reach;
  }
  const d = `M ${round(start.x)} ${round(start.y)} C ${round(c1x)} ${round(start.y)}, ${round(c2x)} ${round(end.y)}, ${round(end.x)} ${round(end.y)}`;
  return { d, start, end };
}
