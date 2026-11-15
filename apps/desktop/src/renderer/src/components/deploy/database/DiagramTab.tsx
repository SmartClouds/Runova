import { type DiagramPoint, layoutDiagram } from '@runova/core';
import type { DbObjectRef } from '@shared/databaseTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Code,
  DiagramProject,
  Download,
  Expand,
  Layers,
  Table,
  Undo,
  X,
  ZoomIn,
  ZoomOut,
} from '@/components/icons';
import {
  EmptyState,
  LoadFailure,
  Notice,
  PillTabs,
  SECTION_HEADING,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import type { WorkbenchTabScope } from '@/stores/databaseWorkbenchStore';
import { buildDiagram, type DiagramCard, relatedTo } from './diagram/diagramModel';
import { clampZoom, type DiagramView, ErdCanvas, revealView, zoomAt } from './diagram/ErdCanvas';
import { diagramSvg, saveFile, svgToPng } from './diagram/exportDiagram';

/**
 * The entity relationship diagram of one database (or one schema): every table as a card, every
 * foreign key as a line. Tables are laid out by their keys, can be dragged, searched and opened,
 * and the picture can be saved as SVG or PNG.
 */

type ColumnsShown = 'all' | 'keys';

/** The table details panel, which takes this much of the canvas when it opens. */
const DETAILS_WIDTH = 256;

/** Where the canvas is when the browser cannot measure it (tests, the first frame). */
const FALLBACK_SIZE = { width: 960, height: 600 };

export function DiagramTab({
  sessionId,
  scope,
  positions: saved,
  onPositionsChange,
  onOpenRows,
  onOpenStructure,
}: {
  sessionId: string;
  scope: WorkbenchTabScope;
  /** Tables the user moved, kept by the workbench tab. */
  positions: Record<string, DiagramPoint> | undefined;
  onPositionsChange: (positions: Record<string, DiagramPoint> | undefined) => void;
  onOpenRows: (ref: DbObjectRef) => void;
  onOpenStructure: (ref: DbObjectRef) => void;
}): React.JSX.Element {
  const graph = useQuery({
    queryKey: queryKeys.databaseDiagram(sessionId, JSON.stringify(scope)),
    queryFn: () =>
      window.runova.database.schemaGraph({
        sessionId,
        database: scope.database,
        schema: scope.schema,
      }),
    retry: false,
    staleTime: 60_000,
  });
  const [shown, setShown] = useState<ColumnsShown>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [moving, setMovingState] = useState<Record<string, DiagramPoint>>({});
  // Mirrors `moving`, so the end of a drag saves the last spot even before React re-renders.
  const movingNow = useRef<Record<string, DiagramPoint>>({});
  const setMoving = (next: Record<string, DiagramPoint>) => {
    movingNow.current = next;
    setMovingState(next);
  };
  const [view, setView] = useState<DiagramView>({ x: 24, y: 24, zoom: 1 });
  const [size, setSize] = useState(FALLBACK_SIZE);
  const frame = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fitted = useRef(false);

  const diagram = useMemo(
    () => (graph.data ? buildDiagram(graph.data, { keysOnly: shown === 'keys' }) : null),
    [graph.data, shown],
  );
  const layout = useMemo(
    () =>
      diagram
        ? layoutDiagram(
            diagram.cards.map((card) => ({ id: card.id, width: card.width, height: card.height })),
            diagram.links.map((link) => ({ from: link.from, to: link.to })),
          )
        : null,
    [diagram],
  );
  const positions = useMemo(
    () => ({ ...(layout?.positions ?? {}), ...(saved ?? {}), ...moving }),
    [layout, saved, moving],
  );

  const bounds = useMemo(() => {
    if (!diagram || diagram.cards.length === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const card of diagram.cards) {
      const at = positions[card.id];
      if (!at) continue;
      minX = Math.min(minX, at.x);
      minY = Math.min(minY, at.y);
      maxX = Math.max(maxX, at.x + card.width);
      maxY = Math.max(maxY, at.y + card.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [diagram, positions]);

  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box && box.width > 0 && box.height > 0) {
        setSize({ width: box.width, height: box.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  const fitView = () => {
    if (!bounds) return;
    const zoom = clampZoom(
      Math.min(1, (size.width - 48) / bounds.width, (size.height - 48) / bounds.height),
    );
    setView({
      zoom,
      x: (size.width - bounds.width * zoom) / 2 - bounds.x * zoom,
      y: (size.height - bounds.height * zoom) / 2 - bounds.y * zoom,
    });
  };

  // Fit once the tables arrive and once more when the canvas is first measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fitting on every move would fight the user.
  useEffect(() => {
    if (!bounds || fitted.current) return;
    fitView();
    if (size !== FALLBACK_SIZE) fitted.current = true;
  }, [bounds, size]);

  const centreOn = (id: string) => {
    const card = diagram?.cards.find((one) => one.id === id);
    const at = positions[id];
    if (!card || !at) return;
    setView((current) => ({
      ...current,
      x: size.width / 2 - (at.x + card.width / 2) * current.zoom,
      y: size.height / 2 - (at.y + card.height / 2) * current.zoom,
    }));
  };

  /** Picks a table, sliding it into sight if the details panel would cover it. */
  const pick = (id: string | null) => {
    setSelected(id);
    const card = id ? diagram?.cards.find((one) => one.id === id) : null;
    const at = id ? positions[id] : null;
    if (!card || !at) return;
    const visible = { width: size.width - (selected ? 0 : DETAILS_WIDTH), height: size.height };
    setView((current) =>
      revealView(current, { ...at, width: card.width, height: card.height }, visible),
    );
  };

  const query = search.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!diagram || !query) return null;
    return new Set(
      diagram.cards
        .filter((card) =>
          [card.name, card.schema ? `${card.schema}.${card.name}` : '']
            .join(' ')
            .toLowerCase()
            .includes(query),
        )
        .map((card) => card.id),
    );
  }, [diagram, query]);
  const focusId = hovered ?? selected;
  const focus = diagram && focusId ? relatedTo(diagram, focusId) : null;
  const picked = diagram?.cards.find((card) => card.id === selected) ?? null;

  async function exportAs(kind: 'svg' | 'png') {
    const svg = svgRef.current;
    if (!svg || !bounds) return;
    const name = `${graph.data?.database ?? 'database'}${scope.schema ? `-${scope.schema}` : ''}-diagram`;
    const markup = diagramSvg(svg, bounds);
    try {
      if (kind === 'svg') {
        saveFile(`${name}.svg`, new Blob([markup], { type: 'image/svg+xml' }));
      } else {
        saveFile(`${name}.png`, await svgToPng(markup));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the picture.');
    }
  }

  if (graph.isPending) {
    return (
      <div className="space-y-3 p-4" aria-busy="true" aria-label="Reading the tables">
        <Skeleton className="h-8 w-80" />
        <div className="grid grid-cols-3 gap-6 pt-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-44" />
          <Skeleton className="h-28" />
        </div>
      </div>
    );
  }
  if (graph.isError) {
    return (
      <div className="p-3">
        <LoadFailure
          message={
            graph.error instanceof Error ? graph.error.message : 'Could not read the tables.'
          }
          retry={() => void graph.refetch()}
        />
      </div>
    );
  }
  if (!diagram || graph.data.tables.length === 0) {
    return (
      <EmptyState
        icon={DiagramProject}
        title="No tables here yet"
        description="Once this database has tables, they show up here with their foreign keys as lines between them."
      />
    );
  }

  const tableCount = graph.data.tables.length;
  const relationCount = graph.data.relations.length;
  const moved = Object.keys(saved ?? {}).length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-foreground/[0.06] px-3 py-2">
        <SearchPill
          type="search"
          label="Find a table"
          clearLabel="Clear the search"
          placeholder="Find a table"
          value={search}
          onValueChange={setSearch}
          className="w-52"
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !matches) return;
            const first = diagram.cards.find((card) => matches.has(card.id));
            if (!first) return;
            setSelected(first.id);
            centreOn(first.id);
          }}
        />
        <PillTabs
          id="diagram-columns"
          label="Columns to show"
          kind="toggle"
          size="xs"
          value={shown}
          onChange={setShown}
          items={[
            { value: 'all', label: 'All columns' },
            { value: 'keys', label: 'Keys only' },
          ]}
        />
        <span className="text-xs text-muted-foreground tabular-nums">
          {`${tableCount} table${tableCount === 1 ? '' : 's'} · ${relationCount} relationship${relationCount === 1 ? '' : 's'}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {moved ? (
            <Button
              size="xs"
              shape="pill"
              variant="ghost"
              onClick={() => {
                setMoving({});
                onPositionsChange(undefined);
                fitted.current = false;
              }}
              title="Put every table back where the layout puts it"
            >
              <Undo /> Re-arrange
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={view.zoom <= 0.2}
            onClick={() =>
              setView((current) =>
                zoomAt(current, current.zoom / 1.2, { x: size.width / 2, y: size.height / 2 }),
              )
            }
          >
            <ZoomOut />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Fit to screen, now at ${Math.round(view.zoom * 100)}%`}
            title="Fit to screen"
            className="w-14 justify-center tabular-nums"
            onClick={fitView}
          >
            {`${Math.round(view.zoom * 100)}%`}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={view.zoom >= 2}
            onClick={() =>
              setView((current) =>
                zoomAt(current, current.zoom * 1.2, { x: size.width / 2, y: size.height / 2 }),
              )
            }
          >
            <ZoomIn />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Fit"
            title="Fit to screen"
            onClick={fitView}
          >
            <Expand />
          </Button>
          <span aria-hidden className="mx-1 h-4 w-px bg-foreground/10" />
          <Button
            size="xs"
            shape="pill"
            variant="soft"
            aria-label="Export as SVG"
            title="Save the diagram as an SVG picture"
            onClick={() => void exportAs('svg')}
          >
            <Download /> SVG
          </Button>
          <Button
            size="xs"
            shape="pill"
            variant="soft"
            aria-label="Export as PNG"
            title="Save the diagram as a PNG picture"
            onClick={() => void exportAs('png')}
          >
            <Download /> PNG
          </Button>
        </div>
      </div>
      {graph.data.truncated ? (
        <Notice tone="warning" size="sm" className="mx-3 mt-2">
          {`Showing ${tableCount} of ${graph.data.totalTables} tables. Open the diagram from one schema in the tree to see the rest.`}
        </Notice>
      ) : null}
      {matches && matches.size === 0 ? (
        <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">
          {`No table matches “${search.trim()}”.`}
        </p>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div ref={frame} className="min-w-0 flex-1">
          <ErdCanvas
            diagram={diagram}
            positions={positions}
            view={view}
            onViewChange={setView}
            focus={focus}
            matches={matches}
            selected={selected}
            onSelect={pick}
            onHover={setHovered}
            onOpen={(card) => onOpenRows(card.ref)}
            onMove={(id, at) => setMoving({ ...movingNow.current, [id]: at })}
            onMoveEnd={() => {
              onPositionsChange({ ...(saved ?? {}), ...movingNow.current });
              setMoving({});
            }}
            svgRef={svgRef}
          />
        </div>
        {picked ? (
          <TableDetails
            card={picked}
            diagram={diagram}
            onPick={(id) => {
              setSelected(id);
              centreOn(id);
            }}
            onClose={() => setSelected(null)}
            onOpenRows={onOpenRows}
            onOpenStructure={onOpenStructure}
          />
        ) : null}
      </div>
      <p className="shrink-0 border-t border-foreground/[0.06] px-3 py-1.5 text-[11px] text-muted-foreground">
        Drag a table to move it, double-click it to see its rows. Scroll to move around, hold Ctrl
        to zoom.
      </p>
    </div>
  );
}

function TableDetails({
  card,
  diagram,
  onPick,
  onClose,
  onOpenRows,
  onOpenStructure,
}: {
  card: DiagramCard;
  diagram: ReturnType<typeof buildDiagram>;
  onPick: (id: string) => void;
  onClose: () => void;
  onOpenRows: (ref: DbObjectRef) => void;
  onOpenStructure: (ref: DbObjectRef) => void;
}): React.JSX.Element {
  const names = new Map(diagram.cards.map((one) => [one.id, one]));
  const outgoing = diagram.links.filter((link) => link.from === card.id);
  const incoming = diagram.links.filter((link) => link.to === card.id);
  const linkList = (title: string, links: typeof outgoing, side: 'from' | 'to') =>
    links.length > 0 ? (
      <section className="space-y-1.5">
        <h4 className={SECTION_HEADING}>{title}</h4>
        <ul className="space-y-1">
          {links.map((link) => {
            const other = names.get(side === 'to' ? link.to : link.from);
            const columns = (side === 'to' ? link.relation.from : link.relation.to).columns;
            return (
              <li key={link.id} className="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => other && onPick(other.id)}
                  className="rounded font-medium text-primary hover:text-primary/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {other?.name ?? '?'}
                </button>
                <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                  {`by ${columns.join(', ')}`}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    ) : null;

  return (
    <aside
      aria-label={card.name}
      style={{ width: DETAILS_WIDTH }}
      className="shrink-0 space-y-4 overflow-auto border-l border-foreground/[0.06] bg-background/40 p-3"
    >
      <div className="flex items-start gap-2">
        <Table className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold" title={card.name}>
            {card.name}
          </h3>
          <p className="truncate text-[11px] text-muted-foreground">
            {[
              card.schema,
              card.rowEstimate === null ? null : `about ${card.rowEstimate.toLocaleString()} rows`,
            ]
              .filter(Boolean)
              .join(' · ') || 'Table'}
          </p>
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="Close details" onClick={onClose}>
          <X />
        </Button>
      </div>
      {card.stub ? (
        <p className="text-xs text-muted-foreground">
          This table lives in another schema. Open that schema's diagram to see all of it.
        </p>
      ) : (
        <div className="flex gap-1.5">
          <Button size="xs" shape="pill" variant="tint" onClick={() => onOpenRows(card.ref)}>
            <Code /> Open rows
          </Button>
          <Button size="xs" shape="pill" variant="soft" onClick={() => onOpenStructure(card.ref)}>
            <Layers /> Structure
          </Button>
        </div>
      )}
      {linkList('References', outgoing, 'to')}
      {linkList('Referenced by', incoming, 'from')}
      {outgoing.length === 0 && incoming.length === 0 ? (
        <p className="text-xs text-muted-foreground">No foreign keys to or from this table.</p>
      ) : null}
      {card.columns.length > 0 ? (
        <section className="space-y-1.5">
          <h4 className={SECTION_HEADING}>Columns</h4>
          <ul className="space-y-0.5">
            {card.columns.map((column) => (
              <li key={column.name} className="flex items-center gap-1.5 text-xs">
                <span
                  className={cn(
                    'w-5 shrink-0 text-[9px] font-bold',
                    column.primaryKey ? 'text-warning' : 'text-primary',
                  )}
                >
                  {column.primaryKey ? 'PK' : column.foreignKey ? 'FK' : ''}
                </span>
                <span className="min-w-0 flex-1 truncate">{column.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {column.type}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
