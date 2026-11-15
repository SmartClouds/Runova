import { describe, expect, it } from 'vitest';
import { type DiagramBox, layoutDiagram, relationPath } from './erdLayout.js';

const box = (id: string, width = 200, height = 120) => ({ id, width, height });

function rects(
  layout: ReturnType<typeof layoutDiagram>,
  nodes: { id: string; width: number; height: number }[],
) {
  return nodes.map(
    (node) => ({ ...node, ...layout.positions[node.id] }) as DiagramBox & { id: string },
  );
}

function overlaps(a: DiagramBox, b: DiagramBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectNoOverlap(all: DiagramBox[]) {
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
  }
}

describe('layoutDiagram', () => {
  it('places a referenced table to the left of the tables that point at it', () => {
    const nodes = [box('order_items'), box('orders'), box('customers'), box('products')];
    const layout = layoutDiagram(nodes, [
      { from: 'order_items', to: 'orders' },
      { from: 'order_items', to: 'products' },
      { from: 'orders', to: 'customers' },
    ]);
    const x = (id: string) => layout.positions[id]?.x ?? Number.NaN;
    expect(x('customers')).toBeLessThan(x('orders'));
    expect(x('orders')).toBeLessThan(x('order_items'));
    expect(x('products')).toBeLessThan(x('order_items'));
    expectNoOverlap(rects(layout, nodes));
  });

  it('places every table, with no overlaps, for tables of different sizes', () => {
    const nodes = Array.from({ length: 30 }, (_, i) =>
      box(`t${i}`, 150 + (i % 4) * 40, 60 + (i % 7) * 30),
    );
    const edges = nodes.slice(1).map((node, i) => ({ from: node.id, to: `t${Math.floor(i / 3)}` }));
    const layout = layoutDiagram(nodes, edges);
    expect(Object.keys(layout.positions).sort()).toEqual(nodes.map((node) => node.id).sort());
    expectNoOverlap(rects(layout, nodes));
  });

  it('survives cycles and tables that point at themselves', () => {
    const nodes = [box('a'), box('b'), box('c'), box('employees')];
    const layout = layoutDiagram(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'employees', to: 'employees' },
    ]);
    expect(Object.keys(layout.positions)).toHaveLength(4);
    expectNoOverlap(rects(layout, nodes));
  });

  it('puts tables with no relations after the related ones', () => {
    const nodes = [box('lonely'), box('child'), box('parent')];
    const layout = layoutDiagram(nodes, [{ from: 'child', to: 'parent' }]);
    const lonely = layout.positions.lonely;
    const parent = layout.positions.parent;
    expect(lonely && parent).toBeTruthy();
    // Read order: the related group first (top, then left), the loner after it.
    const after =
      (lonely?.y ?? 0) > (parent?.y ?? 0) ||
      ((lonely?.y ?? 0) === (parent?.y ?? 0) && (lonely?.x ?? 0) > (parent?.x ?? 0));
    expect(after).toBe(true);
    expectNoOverlap(rects(layout, nodes));
  });

  it('lays out nothing as an empty picture', () => {
    expect(layoutDiagram([], [])).toEqual({ positions: {}, width: 0, height: 0 });
  });

  it('takes the gaps it is given', () => {
    const layout = layoutDiagram(
      [box('child', 100, 50), box('parent', 100, 50)],
      [{ from: 'child', to: 'parent' }],
      { columnGap: 10 },
    );
    expect(layout.positions.parent).toEqual({ x: 0, y: 0 });
    expect(layout.positions.child).toEqual({ x: 110, y: 0 });
    expect(layout.width).toBe(210);
  });

  it('starts a new shelf when the groups get too wide', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => box(`t${i}`, 300, 100));
    const layout = layoutDiagram(nodes, [], { groupGap: 20 });
    const rows = new Set(Object.values(layout.positions).map((at) => at.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(layout.width).toBeLessThan(9 * 300);
  });

  it('ignores relations to tables it was not given', () => {
    const layout = layoutDiagram([box('a')], [{ from: 'a', to: 'missing' }]);
    expect(layout.positions.a).toEqual({ x: 0, y: 0 });
  });

  it('gives the same layout for the same input', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => box(`t${i}`));
    const edges = [
      { from: 't1', to: 't0' },
      { from: 't2', to: 't0' },
      { from: 't3', to: 't1' },
      { from: 't4', to: 't2' },
      { from: 't5', to: 't3' },
      { from: 't5', to: 't4' },
    ];
    expect(layoutDiagram(nodes, edges)).toEqual(layoutDiagram(nodes, edges));
  });

  it('reports a size that holds every table', () => {
    const nodes = [box('a', 100, 50), box('b', 300, 400), box('c')];
    const layout = layoutDiagram(nodes, [{ from: 'b', to: 'a' }]);
    for (const rect of rects(layout, nodes)) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it('orders a layer to cut down crossings', () => {
    // p0 has children c1 and c3, p1 has c0 and c2. A good order groups siblings together.
    const nodes = [box('p0'), box('p1'), box('c0'), box('c1'), box('c2'), box('c3')];
    const layout = layoutDiagram(nodes, [
      { from: 'c0', to: 'p1' },
      { from: 'c1', to: 'p0' },
      { from: 'c2', to: 'p1' },
      { from: 'c3', to: 'p0' },
    ]);
    const y = (id: string) => layout.positions[id]?.y ?? 0;
    const first = y('p0') < y('p1') ? ['c1', 'c3'] : ['c0', 'c2'];
    const second = y('p0') < y('p1') ? ['c0', 'c2'] : ['c1', 'c3'];
    expect(Math.max(...first.map(y))).toBeLessThan(Math.min(...second.map(y)));
  });
});

describe('relationPath', () => {
  const left = { x: 0, y: 0, width: 200, height: 100 };
  const right = { x: 400, y: 0, width: 200, height: 100 };

  it('leaves the right side of a card toward a card on its right', () => {
    const path = relationPath(left, 40, right, 60);
    expect(path.start).toEqual({ x: 200, y: 40, dir: 1 });
    expect(path.end).toEqual({ x: 400, y: 60, dir: -1 });
    expect(path.d.startsWith('M 200 40 C')).toBe(true);
  });

  it('leaves the left side toward a card on its left', () => {
    const path = relationPath(right, 10, left, 20);
    expect(path.start).toEqual({ x: 400, y: 10, dir: -1 });
    expect(path.end).toEqual({ x: 200, y: 20, dir: 1 });
  });

  it('loops out on the right when the cards are stacked', () => {
    const below = { x: 50, y: 300, width: 200, height: 100 };
    const path = relationPath(left, 40, below, 330);
    expect(path.start.dir).toBe(1);
    expect(path.end.dir).toBe(1);
    expect(path.start.x).toBe(200);
    expect(path.end.x).toBe(250);
  });

  it('draws a loop for a table that points at itself', () => {
    const path = relationPath(left, 40, left, 70);
    expect(path.start).toEqual({ x: 200, y: 40, dir: 1 });
    expect(path.end).toEqual({ x: 200, y: 70, dir: 1 });
  });
});
