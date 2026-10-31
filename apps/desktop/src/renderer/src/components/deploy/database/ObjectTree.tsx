import type { DbObjectKind, DbObjectNode, DbObjectRef } from '@shared/databaseTypes';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useState } from 'react';
import {
  ChevronRight,
  Code,
  Database,
  Eye,
  Folder,
  Key,
  Layers,
  Plus,
  Spinner,
  Table,
} from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/**
 * Databases, schemas and tables as a tree that loads each level when it opens. A table (or a
 * collection, or a key) opens its rows; its hover buttons open a query or its structure.
 */

const ICONS: Record<DbObjectKind, React.ComponentType<{ className?: string }>> = {
  database: Database,
  schema: Folder,
  table: Table,
  view: Eye,
  materializedView: Layers,
  collection: Layers,
  key: Key,
};

function refKey(ref: DbObjectRef | null): string {
  return ref ? [ref.database ?? '', ref.schema ?? '', ref.name].join('\u0000') : '';
}

export interface ObjectTreeActions {
  openRows: (node: DbObjectNode) => void;
  openQuery: (node: DbObjectNode) => void;
  openStructure: (node: DbObjectNode) => void;
  /** Starts a new table inside this node. */
  newTable?: (node: DbObjectNode) => void;
}

export function ObjectTree({
  sessionId,
  actions,
  tablesLiveIn,
}: {
  sessionId: string;
  actions: ObjectTreeActions;
  /** Which kind of node holds tables, for the "new table" button on it. */
  tablesLiveIn?: DbObjectKind | null;
}): React.JSX.Element {
  return (
    <div role="tree" aria-label="Databases" className="space-y-px py-1 text-xs">
      <TreeContext.Provider value={tablesLiveIn ?? null}>
        <Level sessionId={sessionId} parent={null} depth={0} actions={actions} />
      </TreeContext.Provider>
    </div>
  );
}

const TreeContext = createContext<DbObjectKind | null>(null);

function Level({
  sessionId,
  parent,
  depth,
  actions,
}: {
  sessionId: string;
  parent: DbObjectNode | null;
  depth: number;
  actions: ObjectTreeActions;
}): React.JSX.Element {
  const children = useQuery({
    queryKey: queryKeys.databaseObjects(
      sessionId,
      refKey(parent?.ref ?? null) + (parent?.kind ?? ''),
    ),
    queryFn: () =>
      window.runova.database.listObjects({
        sessionId,
        parent: parent?.ref ?? null,
        parentKind: parent?.kind ?? null,
      }),
    staleTime: 60_000,
  });
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  if (children.isPending) {
    return (
      <div style={indent} className="flex items-center gap-2 py-1 text-muted-foreground">
        <Spinner className="h-3 w-3 animate-spin" /> Loading
      </div>
    );
  }
  if (children.isError) {
    return (
      <p role="alert" style={indent} className="py-1 pr-2 text-destructive">
        {children.error instanceof Error ? children.error.message : 'Could not read this.'}
      </p>
    );
  }
  if (children.data.length === 0) {
    return (
      <p style={indent} className="py-1 text-muted-foreground/70">
        {depth === 0 ? 'Nothing here.' : 'Empty'}
      </p>
    );
  }
  return (
    <>
      {children.data.map((node) => (
        <Node
          key={`${node.kind}:${refKey(node.ref)}`}
          sessionId={sessionId}
          node={node}
          depth={depth}
          actions={actions}
        />
      ))}
    </>
  );
}

function Node({
  sessionId,
  node,
  depth,
  actions,
}: {
  sessionId: string;
  node: DbObjectNode;
  depth: number;
  actions: ObjectTreeActions;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const tablesLiveIn = useContext(TreeContext);
  const Icon = ICONS[node.kind];
  const leaf = !node.hasChildren;
  const activate = () => (leaf ? actions.openRows(node) : setOpen((value) => !value));

  return (
    <li
      role="treeitem"
      aria-label={node.name}
      aria-expanded={leaf ? undefined : open}
      tabIndex={0}
      className="list-none outline-none"
      onClick={(event) => {
        event.stopPropagation();
        activate();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        } else if (event.key === 'ArrowRight' && !leaf) setOpen(true);
        else if (event.key === 'ArrowLeft' && !leaf) setOpen(false);
      }}
    >
      <div
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        className={cn(
          'group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pr-1 hover:bg-foreground/[0.05]',
          'focus-within:bg-foreground/[0.05]',
        )}
      >
        {leaf ? (
          <span className="w-4 shrink-0" />
        ) : (
          <button
            type="button"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('h-2.5 w-2.5 transition-transform', open && 'rotate-90')} />
          </button>
        )}
        <Icon
          className={cn(
            'h-3 w-3 shrink-0',
            node.kind === 'database' ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={node.name}>
          {node.name}
        </span>
        {node.detail ? (
          <span className="shrink-0 rounded bg-foreground/[0.06] px-1 text-[10px] text-muted-foreground">
            {node.detail}
          </span>
        ) : null}
        {leaf ? (
          <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
            <HoverButton label={`Query ${node.name}`} onClick={() => actions.openQuery(node)}>
              <Code className="h-3 w-3" />
            </HoverButton>
            {node.kind !== 'key' ? (
              <HoverButton
                label={`Structure of ${node.name}`}
                onClick={() => actions.openStructure(node)}
              >
                <Layers className="h-3 w-3" />
              </HoverButton>
            ) : null}
          </span>
        ) : actions.newTable && tablesLiveIn === node.kind ? (
          <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
            <HoverButton
              label={`New table in ${node.name}`}
              onClick={() => actions.newTable?.(node)}
            >
              <Plus className="h-3 w-3" />
            </HoverButton>
          </span>
        ) : null}
        {leaf && node.rowEstimate !== null ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60 group-hover:hidden">
            {compact(node.rowEstimate)}
          </span>
        ) : null}
      </div>
      {open ? (
        <ul role="group" className="m-0 p-0">
          <Level sessionId={sessionId} parent={node} depth={depth + 1} actions={actions} />
        </ul>
      ) : null}
    </li>
  );
}

function HoverButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
    >
      {children}
    </button>
  );
}

function compact(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
