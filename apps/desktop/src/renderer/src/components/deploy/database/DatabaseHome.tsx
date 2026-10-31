import { engineInfo, formatConnectionUrl } from '@runova/core';
import type { DatabaseCandidate, DatabaseConnection, DatabaseSession } from '@shared/databaseTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Docker, Plug, Plus, RefreshCw, Spinner, Trash2 } from '@/components/icons';
import { CARD_GRID, EmptyState, Notice, SectionCard } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { GLASS_EDGE, LIST_ROW, LIST_WELL } from '../deployKit';
import { ConnectionDialog } from './ConnectionDialog';
import { EngineMark } from './EngineMark';
import type { DatabaseConnector } from './useDatabaseConnect';

/**
 * What the Database section shows before a connection is open: every database container it
 * found, each one click from connected, and the connections saved by hand.
 */
export function DatabaseHome({
  server,
  connector,
  onConnected,
}: {
  server: DeployServer | null;
  connector: DatabaseConnector;
  onConnected: (session: DatabaseSession) => void;
}): React.JSX.Element {
  const scope = server?.id ?? 'local';
  const where = server?.nickname ?? 'this computer';
  const [adding, setAdding] = useState(false);
  const discovery = useQuery({
    queryKey: queryKeys.databaseDiscovery(scope),
    queryFn: () => window.runova.database.discover(server?.id ?? null),
    staleTime: 15_000,
  });
  const connections = useQuery({
    queryKey: queryKeys.databaseConnections(),
    queryFn: () => window.runova.database.listConnections(),
  });

  const candidates = discovery.data?.candidates ?? [];
  const fromCards = new Set(candidates.map((one) => one.connectionId).filter(Boolean));
  // Saved connections that belong here and are not already a card above.
  const saved = (connections.data ?? []).filter((connection) => {
    if (fromCards.has(connection.id)) return false;
    const target = connection.target;
    return server
      ? target.kind === 'server' && target.serverId === server.id
      : target.kind !== 'server';
  });

  const connect = async (candidate: DatabaseCandidate) => {
    const session = await connector.connectCandidate(candidate);
    if (session) onConnected(session);
  };
  const connectSaved = async (connection: DatabaseConnection) => {
    const session = await connector.connectSaved(connection.id, connection.name);
    if (session) onConnected(session);
  };

  return (
    <div className="space-y-3">
      <SectionCard
        icon={<Docker />}
        title={`Databases on ${where}`}
        description="Runova finds the database containers, reads how to sign in from them, and connects in one click."
        actions={
          <>
            <Button
              size="sm"
              shape="pill"
              variant="ghost"
              onClick={() => void discovery.refetch()}
              disabled={discovery.isFetching}
              aria-label="Look again"
            >
              <RefreshCw className={cn(discovery.isFetching && 'animate-spin')} /> Look again
            </Button>
            <Button size="sm" shape="pill" variant="tint" onClick={() => setAdding(true)}>
              <Plus /> Add a connection
            </Button>
          </>
        }
      >
        {discovery.data?.problems.map((problem) => (
          <Notice key={problem.source} tone="warning" size="sm" className="mb-3">
            {problem.message}
          </Notice>
        ))}
        {discovery.isPending ? (
          <div className="@container/grid">
            <div className={CARD_GRID}>
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-[7.5rem] rounded-2xl" />
              ))}
            </div>
          </div>
        ) : candidates.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Docker}
            title={`No database containers on ${where} yet`}
            description={
              server
                ? 'Install PostgreSQL, MySQL, MongoDB or Redis from the App Store, or add a connection to a database somewhere else.'
                : 'Start a database container in Docker, or add a connection to a database somewhere else.'
            }
          />
        ) : (
          <div className="@container/grid">
            <div className={CARD_GRID}>
              {candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.key}
                  candidate={candidate}
                  busy={connector.pending === candidate.key}
                  disabled={connector.pending !== null}
                  failure={
                    connector.failure?.key === candidate.key ? connector.failure.message : null
                  }
                  onConnect={() => void connect(candidate)}
                />
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      {saved.length > 0 ? (
        <SectionCard flush icon={<Plug />} title="Saved connections" tone="neutral">
          <ul className={cn(LIST_WELL, 'mx-4 mb-4')}>
            {saved.map((connection) => (
              <SavedRow
                key={connection.id}
                connection={connection}
                busy={connector.pending === connection.id}
                disabled={connector.pending !== null}
                failure={
                  connector.failure?.key === connection.id ? connector.failure.message : null
                }
                onConnect={() => void connectSaved(connection)}
              />
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <ConnectionDialog
        open={adding}
        server={server}
        onOpenChange={setAdding}
        onSaved={(connection) => {
          setAdding(false);
          void connectSaved(connection);
        }}
      />
      {connector.dialogs}
    </div>
  );
}

function CandidateCard({
  candidate,
  busy,
  disabled,
  failure,
  onConnect,
}: {
  candidate: DatabaseCandidate;
  busy: boolean;
  disabled: boolean;
  failure: string | null;
  onConnect: () => void;
}): React.JSX.Element {
  const info = engineInfo(candidate.engine);
  return (
    <div
      role="group"
      aria-label={candidate.containerName}
      className={cn(
        'flex flex-col gap-3 rounded-2xl bg-foreground/[0.03] p-3.5 ring-1 ring-inset ring-foreground/[0.07] transition-colors',
        'hover:bg-foreground/[0.05]',
        failure && GLASS_EDGE.destructive,
      )}
    >
      <div className="flex items-start gap-3">
        <EngineMark engine={candidate.engine} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={candidate.containerName}>
            {candidate.containerName}
          </p>
          <p className="text-xs text-muted-foreground">{info.label}</p>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
            candidate.running
              ? 'bg-success/12 text-success'
              : 'bg-foreground/[0.06] text-muted-foreground',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              candidate.running ? 'bg-success' : 'bg-muted-foreground',
            )}
          />
          {candidate.running ? 'Running' : 'Stopped'}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        {candidate.project ? (
          <span className="rounded-md bg-foreground/[0.05] px-1.5 py-0.5">{candidate.project}</span>
        ) : null}
        <span className="truncate font-mono" title={candidate.image}>
          {candidate.image}
        </span>
      </div>
      {failure ? (
        <p role="alert" className="text-xs leading-relaxed text-destructive">
          {failure}
        </p>
      ) : null}
      <Button
        size="sm"
        shape="pill"
        variant="tint"
        className="mt-auto w-full"
        disabled={disabled || !candidate.running}
        onClick={onConnect}
      >
        {busy ? <Spinner className="animate-spin" /> : <Plug />}
        {busy ? 'Connecting' : 'Connect'}
      </Button>
    </div>
  );
}

function describeTarget(connection: DatabaseConnection): string {
  const target = connection.target;
  switch (target.kind) {
    case 'sqliteFile':
      return target.path;
    case 'localContainer':
      return `${target.containerName} in Docker here`;
    case 'server':
      return `${target.host}:${target.port} on the server`;
    case 'direct':
      return formatConnectionUrl({
        engine: connection.engine === 'sqlite' ? 'postgres' : connection.engine,
        host: target.host,
        port: target.port,
        ...(connection.user ? { user: connection.user } : {}),
        ...(connection.database ? { database: connection.database } : {}),
        tls: connection.tls,
        srv: connection.srv,
      }).replace(/^[a-z+]+:\/\//, '');
  }
}

function SavedRow({
  connection,
  busy,
  disabled,
  failure,
  onConnect,
}: {
  connection: DatabaseConnection;
  busy: boolean;
  disabled: boolean;
  failure: string | null;
  onConnect: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => window.runova.database.removeConnection(connection.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.databaseConnections() }),
  });
  return (
    <li className={cn(LIST_ROW, 'flex flex-wrap items-center gap-3')}>
      <EngineMark engine={connection.engine} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{connection.name}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {describeTarget(connection)}
        </p>
        {failure ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {failure}
          </p>
        ) : null}
      </div>
      {connection.readOnly ? (
        <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px]">Read-only</span>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Forget ${connection.name}`}
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
      >
        <Trash2 />
      </Button>
      <Button size="sm" shape="pill" variant="soft" disabled={disabled} onClick={onConnect}>
        {busy ? <Spinner className="animate-spin" /> : <Plug />} Connect
      </Button>
    </li>
  );
}
