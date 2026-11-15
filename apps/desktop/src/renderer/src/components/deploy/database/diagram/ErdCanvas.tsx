import { type DiagramPoint, relationPath } from '@runova/core';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { CARD, type Diagram, type DiagramCard, type DiagramLink, rowY } from './diagramModel';

/**
 * The diagram itself: an SVG the user pans (drag the background, scroll, or the arrow keys) and
 * zooms (Ctrl or pinch with the wheel, or + and -), with table cards they can drag. Lines use
 * crow's foot ends: the fork sits on the table that holds the key (many rows), the bar on the
 * table it points at (one row). A key column that can be null draws a dashed line and a ring.
 */

export interface DiagramView {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;

export const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));

/** Zooms around a point of the canvas, so what is under the pointer stays under it. */
export function zoomAt(view: DiagramView, zoom: number, at: DiagramPoint): DiagramView {
  const next = clampZoom(zoom);
  const scale = next / view.zoom;
  return { zoom: next, x: at.x - (at.x - view.x) * scale, y: at.y - (at.y - view.y) * scale };
}

/** Shifts the view as little as it takes to show the whole box, or returns it as it was. */
export function revealView(
  view: DiagramView,
  box: { x: number; y: number; width: number; height: number },
  visible: { width: number; height: number },
  margin = 24,
): DiagramView {
  const shift = (start: number, size: number, room: number) => {
    const end = start + size;
    if (end > room - margin) return Math.max(room - margin - end, margin - start);
    if (start < margin) return margin - start;
    return 0;
  };
  const dx = shift(view.x + box.x * view.zoom, box.width * view.zoom, visible.width);
  const dy = shift(view.y + box.y * view.zoom, box.height * view.zoom, visible.height);
  return dx === 0 && dy === 0 ? view : { ...view, x: view.x + dx, y: view.y + dy };
}

const NAME_CHAR = 7.4;
const COLUMN_CHAR = 6.6;
const TYPE_CHAR = 6;

function fit(text: string, room: number, charWidth: number): string {
  const max = Math.max(3, Math.floor(room / charWidth));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function compact(count: number): string {
  if (count < 1000) return `${count} rows`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k rows`;
  return `${(count / 1_000_000).toFixed(1)}M rows`;
}

export function cardLabel(card: DiagramCard): string {
  if (card.stub) return `${card.schema ? `${card.schema}.` : ''}${card.name}, in another schema`;
  const columns = card.columns.length + card.hiddenColumns;
  const rows = card.rowEstimate === null ? '' : `, about ${card.rowEstimate.toLocaleString()} rows`;
  return `${card.name} table, ${columns} column${columns === 1 ? '' : 's'}${rows}`;
}

export function linkTitle(link: DiagramLink): string {
  const { relation } = link;
  const side = (end: typeof relation.from) =>
    end.columns.map((column) => `${end.ref.name}.${column}`).join(', ');
  const rules = [
    relation.onDelete ? `ON DELETE ${relation.onDelete}` : null,
    relation.onUpdate ? `ON UPDATE ${relation.onUpdate}` : null,
  ].filter(Boolean);
  return [`${side(relation.from)} → ${side(relation.to)}`, relation.name, ...rules].join(' · ');
}

export function ErdCanvas({
  diagram,
  positions,
  view,
  onViewChange,
  focus,
  matches,
  selected,
  onSelect,
  onHover,
  onOpen,
  onMove,
  onMoveEnd,
  svgRef,
}: {
  diagram: Diagram;
  positions: Record<string, DiagramPoint>;
  view: DiagramView;
  onViewChange: (view: DiagramView) => void;
  /** The tables to keep bright (the hovered or picked one and its neighbours), or null for all. */
  focus: Set<string> | null;
  /** Tables matching the search, or null when nothing is searched. */
  matches: Set<string> | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onOpen: (card: DiagramCard) => void;
  onMove: (id: string, at: DiagramPoint) => void;
  onMoveEnd: () => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
}): React.JSX.Element {
  const pan = useRef<{ x: number; y: number; view: DiagramView } | null>(null);
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    from: DiagramPoint;
    moved: boolean;
  } | null>(null);
  const dragged = useRef(false);
  const byId = new Map(diagram.cards.map((card) => [card.id, card]));

  const point = (event: { clientX: number; clientY: number }): DiagramPoint => {
    const box = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const dimmed = (id: string) => (matches ? !matches.has(id) : focus ? !focus.has(id) : false);

  return (
    <svg
      ref={svgRef}
      role="application"
      aria-label="Diagram. Drag or use the arrow keys to move around, plus and minus to zoom."
      aria-roledescription="diagram"
      tabIndex={0}
      className="h-full w-full cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 active:cursor-grabbing"
      onPointerDown={(event) => {
        if (
          event.target !== event.currentTarget &&
          !(event.target as Element).hasAttribute('data-backdrop')
        )
          return;
        pan.current = { ...point(event), view };
        (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        onSelect(null);
      }}
      onPointerMove={(event) => {
        const start = pan.current;
        if (!start) return;
        const at = point(event);
        onViewChange({
          ...start.view,
          x: start.view.x + at.x - start.x,
          y: start.view.y + at.y - start.y,
        });
      }}
      onPointerUp={() => {
        pan.current = null;
      }}
      onWheel={(event) => {
        if (event.ctrlKey || event.metaKey) {
          onViewChange(zoomAt(view, view.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), point(event)));
        } else {
          onViewChange({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
        }
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const step = 48;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [step, 0],
          ArrowRight: [-step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        };
        const move = moves[event.key];
        if (move) {
          event.preventDefault();
          onViewChange({ ...view, x: view.x + move[0], y: view.y + move[1] });
        } else if (event.key === '+' || event.key === '=') {
          onViewChange(zoomAt(view, view.zoom * 1.2, centre(svgRef.current)));
        } else if (event.key === '-') {
          onViewChange(zoomAt(view, view.zoom / 1.2, centre(svgRef.current)));
        }
      }}
    >
      <defs>
        <pattern id="erd-dots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" className="fill-foreground/10" />
        </pattern>
      </defs>
      <rect data-backdrop width="100%" height="100%" fill="url(#erd-dots)" />
      <g data-viewport transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
        {diagram.links.map((link) => {
          const from = byId.get(link.from);
          const to = byId.get(link.to);
          const a = positions[link.from];
          const b = positions[link.to];
          if (!from || !to || !a || !b) return null;
          const lit = focus ? focus.has(link.from) && focus.has(link.to) : false;
          const faded = dimmed(link.from) || dimmed(link.to);
          const path = relationPath(
            { ...a, width: from.width, height: from.height },
            rowY(a.y, link.fromRow),
            { ...b, width: to.width, height: to.height },
            rowY(b.y, link.toRow),
          );
          return (
            <g
              key={link.id}
              data-link={link.relation.name}
              className={cn(
                'transition-opacity',
                lit ? 'stroke-primary' : 'stroke-muted-foreground/55',
                faded && 'opacity-20',
              )}
              fill="none"
              strokeWidth={lit ? 1.75 : 1.25}
            >
              <title>{linkTitle(link)}</title>
              <path d={path.d} strokeWidth={10} className="stroke-transparent" />
              <path d={path.d} strokeDasharray={link.optional ? '5 4' : undefined} />
              <Many end={path.start} optional={link.optional} />
              <One end={path.end} />
            </g>
          );
        })}
        {diagram.cards.map((card) => {
          const at = positions[card.id];
          if (!at) return null;
          return (
            <TableCard
              key={card.id}
              card={card}
              at={at}
              selected={selected === card.id}
              dimmed={dimmed(card.id)}
              highlighted={Boolean(matches?.has(card.id))}
              onPointerDown={(event) => {
                event.stopPropagation();
                drag.current = { id: card.id, ...point(event), from: at, moved: false };
                (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
              }}
              onPointerMove={(event) => {
                const state = drag.current;
                if (!state || state.id !== card.id) return;
                const now = point(event);
                const dx = (now.x - state.x) / view.zoom;
                const dy = (now.y - state.y) / view.zoom;
                if (!state.moved && Math.hypot(dx, dy) < 3) return;
                state.moved = true;
                onMove(card.id, {
                  x: Math.round(state.from.x + dx),
                  y: Math.round(state.from.y + dy),
                });
              }}
              onPointerUp={() => {
                const state = drag.current;
                drag.current = null;
                dragged.current = Boolean(state?.moved);
                if (state?.moved) onMoveEnd();
              }}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                onSelect(card.id);
              }}
              onOpen={() => onOpen(card)}
              onHover={onHover}
            />
          );
        })}
      </g>
    </svg>
  );
}

function centre(svg: SVGSVGElement | null): DiagramPoint {
  const box = svg?.getBoundingClientRect();
  return { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 };
}

/** The crow's foot on the side holding the key: a fork for many, with a ring when optional. */
function Many({
  end,
  optional,
}: {
  end: { x: number; y: number; dir: 1 | -1 };
  optional: boolean;
}) {
  const tip = end.x + end.dir * 12;
  return (
    <g>
      <path
        d={`M ${tip} ${end.y} L ${end.x} ${end.y - 6} M ${tip} ${end.y} L ${end.x} ${end.y} M ${tip} ${end.y} L ${end.x} ${end.y + 6}`}
      />
      {optional ? (
        <circle cx={end.x + end.dir * 18} cy={end.y} r={3.5} className="fill-card" />
      ) : (
        <path d={`M ${end.x + end.dir * 16} ${end.y - 6} L ${end.x + end.dir * 16} ${end.y + 6}`} />
      )}
    </g>
  );
}

/** The bar on the side pointed at: exactly one row. */
function One({ end }: { end: { x: number; y: number; dir: 1 | -1 } }) {
  return (
    <path
      d={`M ${end.x + end.dir * 8} ${end.y - 6} L ${end.x + end.dir * 8} ${end.y + 6} M ${end.x + end.dir * 13} ${end.y - 6} L ${end.x + end.dir * 13} ${end.y + 6}`}
    />
  );
}

function TableCard({
  card,
  at,
  selected,
  dimmed,
  highlighted,
  onOpen,
  onHover,
  ...pointer
}: {
  card: DiagramCard;
  at: DiagramPoint;
  selected: boolean;
  dimmed: boolean;
  highlighted: boolean;
  onOpen: () => void;
  onHover: (id: string | null) => void;
  onPointerDown: React.PointerEventHandler<SVGGElement>;
  onPointerMove: React.PointerEventHandler<SVGGElement>;
  onPointerUp: React.PointerEventHandler<SVGGElement>;
  onClick: () => void;
}): React.JSX.Element {
  const { width, height } = card;
  const room = width - 24;
  const typeRoom = Math.min(room * 0.45, 120);
  return (
    <g
      role="button"
      aria-label={cardLabel(card)}
      aria-pressed={selected}
      data-dimmed={dimmed ? 'true' : 'false'}
      tabIndex={0}
      transform={`translate(${at.x} ${at.y})`}
      className={cn(
        'group cursor-pointer outline-none transition-opacity',
        dimmed && 'opacity-30',
        card.stub && 'opacity-70',
      )}
      onPointerEnter={() => onHover(card.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(card.id)}
      onBlur={() => onHover(null)}
      onDoubleClick={() => {
        if (!card.stub) onOpen();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !card.stub) {
          event.preventDefault();
          onOpen();
        } else if (event.key === ' ') {
          event.preventDefault();
          pointer.onClick();
        }
      }}
      {...pointer}
    >
      <rect
        x={-3}
        y={-3}
        width={width + 6}
        height={height + 6}
        rx={13}
        className={cn(
          'fill-none stroke-transparent',
          'group-focus-visible:stroke-ring/60',
          highlighted && 'stroke-warning/70',
        )}
        strokeWidth={2}
      />
      <rect
        width={width}
        height={height}
        rx={10}
        className={cn(
          'fill-card',
          selected ? 'stroke-primary' : 'stroke-foreground/15 group-hover:stroke-foreground/30',
        )}
        strokeWidth={selected ? 2 : 1}
        strokeDasharray={card.stub ? '4 3' : undefined}
      />
      <path
        d={`M 0 10 A 10 10 0 0 1 10 0 L ${width - 10} 0 A 10 10 0 0 1 ${width} 10 L ${width} ${CARD.header} L 0 ${CARD.header} Z`}
        className={selected ? 'fill-primary/15' : 'fill-foreground/[0.05]'}
      />
      <line x1={0} x2={width} y1={CARD.header} y2={CARD.header} className="stroke-foreground/10" />
      <text x={12} y={22} className="fill-foreground text-[12.5px] font-semibold">
        {fit(
          card.stub && card.schema ? `${card.schema}.${card.name}` : card.name,
          room - 70,
          NAME_CHAR,
        )}
      </text>
      <text
        x={width - 12}
        y={22}
        textAnchor="end"
        className="fill-muted-foreground text-[10px] tabular-nums"
      >
        {card.stub ? 'other schema' : card.rowEstimate === null ? '' : compact(card.rowEstimate)}
      </text>
      {card.columns.map((column, index) => {
        const y = CARD.header + index * CARD.row + CARD.row / 2 + 4;
        return (
          <g key={column.name}>
            {column.primaryKey || column.foreignKey ? (
              <text
                x={12}
                y={y}
                className={cn(
                  'text-[8.5px] font-bold tracking-wide',
                  column.primaryKey ? 'fill-warning' : 'fill-primary',
                )}
              >
                {column.primaryKey ? 'PK' : 'FK'}
              </text>
            ) : null}
            <text
              x={34}
              y={y}
              className={cn(
                'fill-foreground text-[11px]',
                column.primaryKey && 'font-semibold',
                column.nullable && !column.primaryKey && 'fill-foreground/80',
              )}
            >
              {fit(
                column.name,
                room - Math.min(column.type.length * TYPE_CHAR, typeRoom) - 30,
                COLUMN_CHAR,
              )}
            </text>
            <text
              x={width - 12}
              y={y}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[10px]"
            >
              {fit(column.type, typeRoom, TYPE_CHAR)}
            </text>
          </g>
        );
      })}
      {card.hiddenColumns > 0 ? (
        <text
          x={12}
          y={CARD.header + card.columns.length * CARD.row + CARD.row / 2 + 4}
          className="fill-muted-foreground text-[10.5px] italic"
        >
          {`+${card.hiddenColumns} more column${card.hiddenColumns === 1 ? '' : 's'}`}
        </text>
      ) : null}
    </g>
  );
}
