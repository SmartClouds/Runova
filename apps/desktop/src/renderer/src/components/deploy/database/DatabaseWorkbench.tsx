import { engineInfo, qualifiedName } from '@runova/core';
import type { DbObjectNode, DbObjectRef, DbTableDescription } from '@shared/databaseTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Code,
  Layers,
  Lock,
  Plug,
  Plus,
  RefreshCw,
  Sliders,
  Table,
  Users,
  X,
} from '@/components/icons';
import { EmptyState, GLASS_PANEL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  useDatabaseWorkbenchStore,
  type WorkbenchScope,
  type WorkbenchTab,
} from '@/stores/databaseWorkbenchStore';
import { DataTab } from './DataTab';
import { EngineMark } from './EngineMark';
import { ObjectTree } from './ObjectTree';
import { QueryTab } from './QueryTab';
import { SettingsTab } from './SettingsTab';
import { StructureTab } from './StructureTab';
import { type DesignerTarget, TableDesigner } from './TableDesigner';
import { UsersTab } from './UsersTab';

/**
 * An open connection: the object tree on the left, tabs for rows, structure and queries in the
 * middle. Tabs stay while the app runs, so coming back to the section finds them as they were.
 */

const TAB_ICONS = {
  data: Table,
  query: Code,
  structure: Layers,
  settings: Sliders,
  users: Users,
} as const;

function starterQuery(
  engine: WorkbenchScope['session']['connection']['engine'],
  node?: DbObjectNode,
) {
  const info = engineInfo(engine);
  if (!node) return info.sampleQuery;
  if (engine === 'mongodb')
    return `db.getCollection(${JSON.stringify(node.name)}).find({}).limit(50)`;
  if (engine === 'redis') return `TYPE ${node.name}`;
  const table = qualifiedName(engine, node.ref);
  return engine === 'mssql'
    ? `SELECT TOP 100 * FROM ${table};`
    : `SELECT * FROM ${table} LIMIT 100;`;
}

export function DatabaseWorkbench({
  scope,
  state,
  onDisconnect,
}: {
  scope: string;
  state: WorkbenchScope;
  onDisconnect: () => void;
}): React.JSX.Element {
  const { session, tabs, activeTabId } = state;
  const { connection } = session;
  const store = useDatabaseWorkbenchStore();
  const [designer, setDesigner] = useState<DesignerTarget | null>(null);
  const queryClient = useQueryClient();
  const [treeWidth, setTreeWidth] = useState(250);
  const info = engineInfo(connection.engine);
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const openQuery = (node?: DbObjectNode) =>
    store.openTab(scope, {
      kind: 'query',
      title: node ? node.name : `Query ${tabs.filter((tab) => tab.kind === 'query').length + 1}`,
      text: starterQuery(connection.engine, node),
      database: node?.ref.database ?? connection.database,
    });

  const actions = {
    openRows: (node: DbObjectNode) =>
      store.openTab(scope, {
        kind: 'data',
        title: node.name,
        ref: node.ref,
        objectKind: node.kind,
      }),
    openStructure: (node: DbObjectNode) =>
      store.openTab(scope, {
        kind: 'structure',
        title: node.name,
        ref: node.ref,
        objectKind: node.kind,
      }),
    openQuery: (node: DbObjectNode) => openQuery(node),
    ...(info.capabilities.createTable
      ? {
          newTable: (node: DbObjectNode) =>
            setDesigner({
              mode: 'create',
              where: {
                ...(node.ref.database ? { database: node.ref.database } : {}),
                ...(node.kind === 'schema' ? { schema: node.ref.schema ?? node.name } : {}),
              },
            }),
        }
      : {}),
  };
  const defaultWhere = (): Omit<DbObjectRef, 'name'> => {
    const database = connection.database ?? undefined;
    if (connection.engine === 'postgres') return { database, schema: 'public' };
    if (connection.engine === 'mssql') return { database, schema: 'dbo' };
    if (connection.engine === 'sqlite') return {};
    return { database };
  };

  return (
    <div className="flex h-[calc(100vh-13rem)] min-h-[32rem] flex-col gap-2">
      <header className={cn(GLASS_PANEL, 'flex-row flex-wrap items-center gap-3 px-3 py-2.5')}>
        <EngineMark engine={connection.engine} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{connection.name}</h2>
            {connection.readOnly ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[10px] font-medium text-warning">
                <Lock className="h-2.5 w-2.5" /> Read-only
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {info.label} {session.serverVersion}
            {connection.user ? ` · signed in as ${connection.user}` : ''}
          </p>
        </div>
        {info.capabilities.createTable ? (
          <Button
            size="sm"
            shape="pill"
            variant="soft"
            onClick={() => setDesigner({ mode: 'create', where: defaultWhere() })}
          >
            <Table /> New {info.objectNoun}
          </Button>
        ) : null}
        <Button size="sm" shape="pill" variant="tint" onClick={() => openQuery()}>
          <Plus /> New query
        </Button>
        {info.capabilities.users ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Users and access"
            title="Users and access"
            onClick={() => store.openTab(scope, { kind: 'users', title: 'Users' })}
          >
            <Users />
          </Button>
        ) : null}
        {info.capabilities.settings ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Server settings"
            title="Server settings"
            onClick={() => store.openTab(scope, { kind: 'settings', title: 'Settings' })}
          >
            <Sliders />
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Reload the tree"
          onClick={() =>
            void queryClient.invalidateQueries({
              queryKey: queryKeys.databaseSession(session.sessionId),
            })
          }
        >
          <RefreshCw />
        </Button>
        <Button size="sm" shape="pill" variant="soft" onClick={onDisconnect}>
          <Plug /> Disconnect
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 gap-0">
        <aside
          className={cn(GLASS_PANEL, 'shrink-0 overflow-auto')}
          style={{ width: treeWidth }}
          aria-label="Objects"
        >
          <ObjectTree
            sessionId={session.sessionId}
            actions={actions}
            tablesLiveIn={
              info.capabilities.schemas ? 'schema' : info.capabilities.databases ? 'database' : null
            }
          />
        </aside>
        <ResizeHandle
          orientation="vertical"
          label="Resize the object list"
          size={treeWidth}
          min={180}
          max={480}
          defaultSize={250}
          onSizeChange={setTreeWidth}
          quiet
          className="mx-0.5"
        />
        <section className={cn(GLASS_PANEL, 'min-w-0 flex-1')}>
          {tabs.length > 0 ? (
            <div
              role="tablist"
              aria-label="Open tabs"
              className="flex shrink-0 gap-px overflow-x-auto border-b border-foreground/[0.06] px-1.5 pt-1.5"
            >
              {tabs.map((tab) => (
                <TabButton
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  onSelect={() => store.setActive(scope, tab.id)}
                  onClose={() => store.closeTab(scope, tab.id)}
                />
              ))}
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            {active ? (
              <TabBody
                key={active.id}
                scope={scope}
                state={state}
                tab={active}
                onEditColumns={
                  info.capabilities.createTable
                    ? (table) => setDesigner({ mode: 'edit', table })
                    : undefined
                }
              />
            ) : (
              <EmptyState
                icon={Table}
                title="Pick a table, or write a query"
                description="Click a table on the left to see its rows. Hover it for its structure or a ready query."
                action={
                  <Button size="sm" shape="pill" onClick={() => openQuery()}>
                    <Code /> Write a query
                  </Button>
                }
              />
            )}
          </div>
        </section>
      </div>
      <TableDesigner
        sessionId={session.sessionId}
        engine={connection.engine}
        target={designer}
        onClose={() => setDesigner(null)}
      />
    </div>
  );
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: WorkbenchTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const Icon = TAB_ICONS[tab.kind];
  return (
    <div
      className={cn(
        'group flex h-8 max-w-[14rem] shrink-0 items-center gap-1 rounded-t-lg pl-2.5 pr-1 text-xs',
        active
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:bg-foreground/[0.04]',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className="flex min-w-0 items-center gap-1.5 outline-none"
      >
        <Icon className={cn('h-3 w-3 shrink-0', active && 'text-primary')} />
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={onClose}
        className="flex h-5 w-5 items-center justify-center rounded opacity-60 hover:bg-foreground/[0.08] hover:opacity-100"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

function TabBody({
  scope,
  state,
  tab,
  onEditColumns,
}: {
  scope: string;
  state: WorkbenchScope;
  tab: WorkbenchTab;
  onEditColumns?: (table: DbTableDescription) => void;
}): React.JSX.Element {
  const updateTab = useDatabaseWorkbenchStore((store) => store.updateTab);
  const { session } = state;
  if (tab.kind === 'data' && tab.ref) {
    return (
      <DataTab
        sessionId={session.sessionId}
        engine={session.connection.engine}
        readOnly={session.connection.readOnly}
        objectRef={tab.ref}
      />
    );
  }
  if (tab.kind === 'settings') {
    return <SettingsTab sessionId={session.sessionId} engine={session.connection.engine} />;
  }
  if (tab.kind === 'users') {
    return (
      <UsersTab
        sessionId={session.sessionId}
        engine={session.connection.engine}
        defaultDatabase={session.connection.database}
      />
    );
  }
  if (tab.kind === 'structure' && tab.ref) {
    return (
      <StructureTab
        sessionId={session.sessionId}
        objectRef={tab.ref}
        onEditColumns={onEditColumns}
      />
    );
  }
  return (
    <QueryTab
      sessionId={session.sessionId}
      engine={session.connection.engine}
      readOnly={session.connection.readOnly}
      text={tab.text ?? ''}
      database={tab.database ?? null}
      onTextChange={(text) => updateTab(scope, tab.id, { text })}
    />
  );
}
