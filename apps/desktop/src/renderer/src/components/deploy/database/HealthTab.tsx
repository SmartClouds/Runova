import {
  type AdviceSeverity,
  type DbEngine,
  type MaintenanceAction,
  type MaintenanceAdvice,
  type MaintenanceScope,
  maintenanceActions,
  maintenanceAdvice,
  PRECISE_STATS_STATEMENT,
} from '@runova/core';
import type { DbIndexHealth, DbTableStorage } from '@shared/databaseTypes';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Gauge, RefreshCw, Wrench } from '@/components/icons';
import {
  Chip,
  type ChipTone,
  EmptyState,
  LoadFailure,
  Notice,
  PillTabs,
  SECTION_HEADING,
  SearchPill,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import type { WorkbenchTabScope } from '@/stores/databaseWorkbenchStore';
import {
  MaintenanceDialog,
  type MaintenanceItem,
  type MaintenanceRequest,
} from './MaintenanceDialog';

/**
 * Index health for one database: how fragmented (or bloated) each index is, how much free space
 * each table holds, the engine's advice for each, and its own way to tidy up (rebuild, reorganize,
 * reindex, vacuum, optimize). Nothing runs before its statements were shown.
 */

type Filter = 'all' | 'attention' | 'clustered' | 'nonclustered';

const SEVERITY_ORDER: Record<AdviceSeverity, number> = {
  bad: 0,
  warn: 1,
  ok: 2,
  small: 3,
  unknown: 4,
};

const TONE: Record<AdviceSeverity, ChipTone> = {
  bad: 'destructive',
  warn: 'warning',
  ok: 'success',
  small: 'neutral',
  unknown: 'neutral',
};

const TYPE_LABEL: Record<DbIndexHealth['type'], string> = {
  clustered: 'Clustered',
  nonclustered: 'Nonclustered',
  heap: 'Heap',
  columnstore: 'Columnstore',
  btree: 'B-tree',
  hash: 'Hash',
  gin: 'GIN',
  gist: 'GiST',
  brin: 'BRIN',
  spgist: 'SP-GiST',
  fulltext: 'Full text',
  spatial: 'Spatial',
  other: 'Other',
};

interface IndexRow {
  key: string;
  index: DbIndexHealth;
  scope: MaintenanceScope;
  advice: MaintenanceAdvice;
  /** The clean-up the advice points to, if any. */
  fix: MaintenanceAction | null;
}

const indexKey = (index: DbIndexHealth) =>
  JSON.stringify([
    index.table.database ?? null,
    index.table.schema ?? null,
    index.table.name,
    index.name,
  ]);

const tableName = (table: DbIndexHealth['table']) =>
  table.schema ? `${table.schema}.${table.name}` : table.name;

/** The word an engine uses for the action, for a chip like "Reindex advised". */
function actionLabel(engine: DbEngine, scope: MaintenanceScope, action: MaintenanceAction): string {
  return maintenanceActions(engine, scope).find((one) => one.action === action)?.label ?? action;
}

function adviceText(
  engine: DbEngine,
  scope: MaintenanceScope,
  advice: MaintenanceAdvice,
  fix: MaintenanceAction | null,
) {
  if (fix) return `${actionLabel(engine, scope, fix)} advised`;
  if (advice.severity === 'small') return 'Too small';
  if (advice.severity === 'unknown') return 'Not measured';
  if (advice.severity === 'warn') return 'Watch';
  return 'Healthy';
}

function indexRow(engine: DbEngine, index: DbIndexHealth): IndexRow {
  const scope: MaintenanceScope = index.type === 'heap' ? 'heap' : 'index';
  const advice = maintenanceAdvice(engine, {
    fragmentationPercent: index.fragmentationPercent,
    pageCount: index.pageCount,
    sizeBytes: index.sizeBytes,
  });
  const offered = maintenanceActions(engine, scope).map((one) => one.action);
  const wanted = advice.action === 'none' ? null : advice.action;
  // A heap has no reorganize: a fragmented one gets a rebuild.
  const fix =
    wanted && offered.includes(wanted)
      ? wanted
      : wanted && offered.includes('rebuild')
        ? 'rebuild'
        : null;
  return { key: indexKey(index), index, scope, advice, fix };
}

function tableAdvice(engine: DbEngine, table: DbTableStorage) {
  if (engine === 'mssql') return null;
  const whole = (table.dataBytes ?? 0) + (table.indexBytes ?? 0) + (table.freeBytes ?? 0);
  const advice = maintenanceAdvice(engine, {
    fragmentationPercent: table.freePercent,
    pageCount: null,
    sizeBytes: engine === 'postgres' ? table.dataBytes : whole,
  });
  // PostgreSQL's dead rows are cleared by a vacuum, not a reindex.
  const fix: MaintenanceAction | null =
    advice.action === 'none' ? null : engine === 'postgres' ? 'vacuum' : 'rebuild';
  return {
    advice,
    fix: fix && maintenanceActions(engine, 'table').some((one) => one.action === fix) ? fix : null,
  };
}

function percent(value: number | null): string {
  return value === null
    ? ''
    : `${value.toFixed(value < 10 && value % 1 !== 0 ? 1 : value % 1 === 0 ? 0 : 1)}%`;
}

export function HealthTab({
  sessionId,
  engine,
  readOnly,
  scope,
}: {
  sessionId: string;
  engine: DbEngine;
  readOnly: boolean;
  scope: WorkbenchTabScope;
}): React.JSX.Element {
  const [scan, setScan] = useState<'fast' | 'thorough'>('fast');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [request, setRequest] = useState<MaintenanceRequest | null>(null);

  const health = useQuery({
    queryKey: queryKeys.databaseHealth(sessionId, JSON.stringify(scope), scan),
    queryFn: () =>
      window.runova.database.health({
        sessionId,
        database: scope.database,
        schema: scope.schema,
        scan,
      }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const rows = useMemo(
    () =>
      (health.data?.indexes ?? [])
        .map((index) => indexRow(engine, index))
        .sort(
          (a, b) =>
            SEVERITY_ORDER[a.advice.severity] - SEVERITY_ORDER[b.advice.severity] ||
            (b.index.fragmentationPercent ?? -1) - (a.index.fragmentationPercent ?? -1),
        ),
    [health.data, engine],
  );

  const rescan = () => {
    setPicked(new Set());
    void health.refetch();
  };
  const run = (next: Omit<MaintenanceRequest, 'onDone'>) => setRequest({ ...next, onDone: rescan });

  if (health.isPending) {
    return (
      <div className="space-y-3 p-4" aria-busy="true" aria-label="Measuring the indexes">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[0, 1, 2, 3].map((one) => (
            <Skeleton key={one} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-48 w-full" />
        <p className="text-xs text-muted-foreground">
          {scan === 'thorough'
            ? 'Sampling every index. On a big database this takes a while.'
            : 'Measuring.'}
        </p>
      </div>
    );
  }
  if (health.isError) {
    return (
      <div className="p-3">
        <LoadFailure
          message={
            health.error instanceof Error ? health.error.message : 'Could not measure the indexes.'
          }
          retry={() => void health.refetch()}
        />
      </div>
    );
  }

  const report = health.data;
  const attention = rows.filter((row) => row.fix !== null);
  const kinds = new Set(rows.map((row) => row.index.type));
  const hasClusterKinds = kinds.has('clustered') || kinds.has('nonclustered');
  const query = search.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (filter === 'attention' && !row.fix) return false;
    if (filter === 'clustered' && row.index.type !== 'clustered') return false;
    if (filter === 'nonclustered' && row.index.type !== 'nonclustered') return false;
    if (!query) return true;
    return `${row.index.name ?? 'heap'} ${tableName(row.index.table)}`
      .toLowerCase()
      .includes(query);
  });
  const selectable = !readOnly;
  const measured = rows.filter(
    (row) => row.index.fragmentationPercent !== null && row.advice.severity !== 'small',
  );
  const pages = measured.reduce((sum, row) => sum + (row.index.pageCount ?? 1), 0);
  const average =
    measured.length === 0
      ? null
      : measured.reduce(
          (sum, row) => sum + (row.index.fragmentationPercent ?? 0) * (row.index.pageCount ?? 1),
          0,
        ) / Math.max(1, pages);
  const databaseFree =
    report.totalBytes && report.freeBytes !== null
      ? Math.round((report.freeBytes / report.totalBytes) * 1000) / 10
      : null;
  const databaseAdvice =
    engine === 'sqlite' && databaseFree !== null
      ? maintenanceAdvice('sqlite', {
          fragmentationPercent: databaseFree,
          pageCount: null,
          sizeBytes: report.totalBytes,
        })
      : null;
  const databaseActions = maintenanceActions(engine, 'database');
  const chosen = attention.filter((row) => picked.has(row.key));

  const fixRows = (list: IndexRow[]) =>
    run({
      title:
        list.length === 1
          ? `Fix ${list[0]?.index.name ?? 'the heap'}`
          : `Fix ${list.length} indexes`,
      description: 'Each index gets what its fragmentation calls for.',
      action: 'Run',
      items: list.flatMap((row): MaintenanceItem[] =>
        row.fix ? [{ action: row.fix, target: targetOf(row) }] : [],
      ),
    });

  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Gauge className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Index health</h3>
        <span className="text-xs text-muted-foreground">
          {report.database ?? 'This database'}
          {scope.schema ? ` · ${scope.schema}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {engine === 'mssql' || engine === 'postgres' ? (
            <PillTabs
              id="health-scan"
              label="How closely to look"
              kind="toggle"
              size="xs"
              value={scan}
              onChange={setScan}
              items={[
                { value: 'fast', label: 'Fast' },
                { value: 'thorough', label: 'Thorough' },
              ]}
            />
          ) : null}
          <Button
            size="xs"
            shape="pill"
            variant="soft"
            onClick={rescan}
            disabled={health.isFetching}
            aria-label="Measure again"
          >
            <RefreshCw className={cn(health.isFetching && 'animate-spin')} /> Rescan
          </Button>
        </div>
      </div>
      <p className="-mt-2 text-[11px] text-muted-foreground">
        {`Measured with ${report.method} at ${new Date(report.measuredAt).toLocaleTimeString()}.`}
      </p>

      {readOnly ? (
        <Notice tone="warning" size="sm">
          This connection is read-only, so nothing here can be rebuilt. The numbers still show.
        </Notice>
      ) : null}
      {report.canBePrecise ? (
        <Notice tone="primary" size="sm">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              These numbers are estimates from the planner's statistics. The pgstattuple extension
              reads them exactly.
            </span>
            {readOnly ? null : (
              <Button
                size="xs"
                shape="pill"
                variant="tint"
                onClick={() =>
                  setRequest({
                    title: 'Add pgstattuple',
                    description:
                      'It ships with PostgreSQL and only reads. A thorough scan then measures every index exactly.',
                    action: 'Add the extension',
                    items: [],
                    statements: [PRECISE_STATS_STATEMENT],
                    onDone: () => setScan('thorough'),
                  })
                }
              >
                Add pgstattuple
              </Button>
            )}
          </span>
        </Notice>
      ) : null}
      {report.notes.length > 0 ? (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile
          label="Database size"
          value={report.totalBytes === null ? 'Unknown' : formatBytes(report.totalBytes)}
        >
          {databaseFree !== null ? `${percent(databaseFree)} free` : null}
        </Tile>
        <Tile label="Indexes" value={String(rows.length)}>
          {`${new Set(rows.map((row) => tableName(row.index.table))).size} tables`}
        </Tile>
        <Tile
          label="Need attention"
          value={String(attention.length)}
          tone={
            attention.some((row) => row.advice.severity === 'bad')
              ? 'destructive'
              : attention.length > 0
                ? 'warning'
                : 'success'
          }
        >
          {attention.length === 0 ? 'All good' : 'See the list below'}
        </Tile>
        <Tile
          label={
            engine === 'postgres'
              ? 'Average bloat'
              : engine === 'mysql' || engine === 'mariadb'
                ? 'Average free space'
                : 'Average fragmentation'
          }
          value={average === null ? 'n/a' : percent(Math.round(average * 10) / 10)}
        >
          {engine === 'mysql' || engine === 'mariadb' ? 'Measured per table' : 'Weighted by size'}
        </Tile>
      </div>

      {databaseActions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-inset ring-foreground/[0.07]">
          <span className="text-xs font-medium">Whole database</span>
          {databaseAdvice && databaseAdvice.action !== 'none' ? (
            <Chip tone={TONE[databaseAdvice.severity]}>{databaseAdvice.reason}</Chip>
          ) : null}
          <span className="ml-auto flex gap-1.5">
            {databaseActions.map((one) => (
              <Button
                key={one.action}
                size="xs"
                shape="pill"
                variant={
                  databaseAdvice?.action !== 'none' && one.action === 'vacuum' ? 'tint' : 'soft'
                }
                disabled={readOnly}
                title={one.description}
                onClick={() =>
                  run({
                    title: `${one.label} the whole database`,
                    description: one.description,
                    action: one.label,
                    items: [{ action: one.action, target: { scope: 'database' } }],
                  })
                }
              >
                {one.label}
              </Button>
            ))}
          </span>
        </div>
      ) : null}

      <section className="space-y-2" aria-label="Indexes">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className={SECTION_HEADING}>Indexes</h4>
          <PillTabs
            id="health-filter"
            label="Which indexes"
            kind="toggle"
            size="xs"
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: 'All', count: rows.length },
              {
                value: 'attention',
                label: 'Needs attention',
                count: attention.length,
                countTone: 'warning',
              },
              ...(hasClusterKinds
                ? [
                    { value: 'clustered' as const, label: 'Clustered' },
                    { value: 'nonclustered' as const, label: 'Nonclustered' },
                  ]
                : []),
            ]}
          />
          <SearchPill
            type="search"
            label="Find an index or table"
            clearLabel="Clear the search"
            placeholder="Find an index or table"
            value={search}
            onValueChange={setSearch}
            className="ml-auto w-56"
          />
          {chosen.length > 0 ? (
            <Button size="xs" shape="pill" variant="tint" onClick={() => fixRows(chosen)}>
              <Wrench /> {`Fix ${chosen.length} ${chosen.length === 1 ? 'index' : 'indexes'}`}
            </Button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={Gauge}
            size="sm"
            title="No indexes here"
            description="Tables with no indexes have nothing to measure yet."
          />
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Nothing matches.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl ring-1 ring-inset ring-foreground/[0.07]">
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  {selectable ? (
                    <th className={cn(HEAD, 'w-8')}>
                      <Checkbox
                        aria-label="Select every index that needs attention"
                        disabled={attention.length === 0}
                        checked={
                          attention.length > 0 && chosen.length === attention.length
                            ? true
                            : chosen.length > 0
                              ? 'indeterminate'
                              : false
                        }
                        onCheckedChange={(value) =>
                          setPicked(
                            value === true ? new Set(attention.map((row) => row.key)) : new Set(),
                          )
                        }
                      />
                    </th>
                  ) : null}
                  <th className={HEAD}>Index</th>
                  <th className={HEAD}>Type</th>
                  <th className={cn(HEAD, 'hidden xl:table-cell')}>Columns</th>
                  <th className={cn(HEAD, 'text-right')}>Size</th>
                  <th className={cn(HEAD, 'w-44')}>
                    {engine === 'postgres'
                      ? 'Bloat'
                      : engine === 'sqlite'
                        ? 'Empty space'
                        : 'Fragmentation'}
                  </th>
                  <th className={HEAD}>Advice</th>
                  <th className={cn(HEAD, 'text-right')}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <IndexLine
                    key={row.key}
                    engine={engine}
                    row={row}
                    readOnly={readOnly}
                    selectable={selectable}
                    picked={picked.has(row.key)}
                    onPick={(value) =>
                      setPicked((current) => {
                        const next = new Set(current);
                        if (value) next.add(row.key);
                        else next.delete(row.key);
                        return next;
                      })
                    }
                    onRun={(action) => {
                      const label = actionLabel(engine, row.scope, action);
                      run({
                        title: `${label} ${row.index.name ?? `the heap of ${row.index.table.name}`}`,
                        description: maintenanceActions(engine, row.scope).find(
                          (one) => one.action === action,
                        )?.description,
                        action: label,
                        items: [{ action, target: targetOf(row) }],
                      });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {report.tables.length > 0 ? (
        <TablesSection
          engine={engine}
          tables={report.tables}
          readOnly={readOnly}
          onRun={(table, action) => {
            const label = actionLabel(engine, 'table', action);
            run({
              title: `${label} ${table.table.name}`,
              description: maintenanceActions(engine, 'table').find((one) => one.action === action)
                ?.description,
              action: label,
              items: [{ action, target: { scope: 'table', table: table.table } }],
            });
          }}
        />
      ) : null}

      <MaintenanceDialog
        sessionId={sessionId}
        engine={engine}
        database={report.database ?? scope.database}
        onlineRebuild={report.onlineRebuild}
        request={request}
        onClose={() => setRequest(null)}
      />
    </div>
  );
}

const HEAD = 'border-b border-foreground/[0.06] px-3 py-2 font-medium';
const CELL = 'border-b border-foreground/[0.04] px-3 py-1.5 align-middle';

function targetOf(row: IndexRow): MaintenanceItem['target'] {
  if (row.scope === 'heap' || row.index.name === null)
    return { scope: 'heap', table: row.index.table };
  return { scope: 'index', table: row.index.table, index: row.index.name };
}

function Tile({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone?: ChipTone;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className="rounded-xl bg-foreground/[0.03] px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.07]"
    >
      <p className={SECTION_HEADING}>{label}</p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'destructive' && 'text-destructive',
          tone === 'warning' && 'text-warning',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </p>
      {children ? <p className="text-[11px] text-muted-foreground">{children}</p> : null}
    </div>
  );
}

/** A thin bar for a percentage, coloured by how much it matters. */
function Meter({
  value,
  severity,
}: {
  value: number | null;
  severity: AdviceSeverity;
}): React.JSX.Element {
  if (value === null) return <span className="text-muted-foreground">n/a</span>;
  const colour =
    severity === 'bad'
      ? 'bg-destructive'
      : severity === 'warn'
        ? 'bg-warning'
        : severity === 'ok'
          ? 'bg-success'
          : 'bg-muted-foreground/40';
  return (
    <span className="flex items-center gap-2">
      <span
        className="h-1.5 w-24 overflow-hidden rounded-full bg-foreground/[0.07]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-label="Fragmentation"
      >
        <span
          className={cn('block h-full rounded-full', colour)}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </span>
      <span className="w-12 tabular-nums">{percent(value)}</span>
    </span>
  );
}

function IndexLine({
  engine,
  row,
  readOnly,
  selectable,
  picked,
  onPick,
  onRun,
}: {
  engine: DbEngine;
  row: IndexRow;
  readOnly: boolean;
  selectable: boolean;
  picked: boolean;
  onPick: (value: boolean) => void;
  onRun: (action: MaintenanceAction) => void;
}): React.JSX.Element {
  const { index, advice, fix } = row;
  const actions = maintenanceActions(engine, row.scope).filter(
    (one) => one.action !== 'statistics',
  );
  const name = index.name ?? 'Heap';
  const perTable =
    index.fragmentationPercent === null && (engine === 'mysql' || engine === 'mariadb');
  return (
    <tr className={cn('hover:bg-foreground/[0.02]', picked && 'bg-primary/[0.04]')}>
      {selectable ? (
        <td className={CELL}>
          {fix ? (
            <Checkbox
              aria-label={`Select ${name}`}
              checked={picked}
              onCheckedChange={(value) => onPick(value === true)}
            />
          ) : null}
        </td>
      ) : null}
      <td className={cn(CELL, 'max-w-[16rem]')}>
        <span className="block truncate font-medium" title={name}>
          {name}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {tableName(index.table)}
        </span>
      </td>
      <td className={CELL}>
        <span className="flex flex-wrap gap-1">
          <Chip tone={index.type === 'clustered' ? 'primary' : 'neutral'}>
            {TYPE_LABEL[index.type]}
          </Chip>
          {index.primary ? (
            <Chip tone="warning">PK</Chip>
          ) : index.unique ? (
            <Chip>Unique</Chip>
          ) : null}
        </span>
      </td>
      <td
        className={cn(
          CELL,
          'hidden max-w-[14rem] truncate font-mono text-[11px] text-muted-foreground xl:table-cell',
        )}
      >
        {index.columns.join(', ')}
      </td>
      <td className={cn(CELL, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>
        {index.sizeBytes === null ? '' : formatBytes(index.sizeBytes)}
      </td>
      <td className={CELL}>
        {perTable ? (
          <span
            className="text-muted-foreground"
            title="MySQL measures free space per table, below."
          >
            By table
          </span>
        ) : (
          <Meter value={index.fragmentationPercent} severity={advice.severity} />
        )}
      </td>
      <td className={CELL}>
        {perTable ? null : (
          <Chip tone={TONE[advice.severity]} title={advice.reason}>
            {adviceText(engine, row.scope, advice, fix)}
          </Chip>
        )}
      </td>
      <td className={cn(CELL, 'whitespace-nowrap text-right')}>
        <span className="inline-flex gap-1">
          {actions.map((one) => (
            <Button
              key={one.action}
              size="xs"
              shape="pill"
              variant={fix === one.action ? 'tint' : 'ghost'}
              disabled={readOnly}
              aria-label={`${one.label} ${index.name ?? `the heap of ${index.table.name}`}`}
              title={readOnly ? 'This connection is read-only' : one.description}
              onClick={() => onRun(one.action)}
            >
              {one.label}
            </Button>
          ))}
        </span>
      </td>
    </tr>
  );
}

function TablesSection({
  engine,
  tables,
  readOnly,
  onRun,
}: {
  engine: DbEngine;
  tables: DbTableStorage[];
  readOnly: boolean;
  onRun: (table: DbTableStorage, action: MaintenanceAction) => void;
}): React.JSX.Element {
  const actions = maintenanceActions(engine, 'table');
  const sorted = [...tables].sort((a, b) => (b.freePercent ?? -1) - (a.freePercent ?? -1));
  return (
    <section className="space-y-2" aria-label="Tables and free space">
      <h4 className={SECTION_HEADING}>Tables and free space</h4>
      <div className="overflow-x-auto rounded-xl ring-1 ring-inset ring-foreground/[0.07]">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className={HEAD}>Table</th>
              <th className={cn(HEAD, 'text-right')}>Rows</th>
              <th className={cn(HEAD, 'text-right')}>Data</th>
              <th className={cn(HEAD, 'text-right')}>Indexes</th>
              <th className={cn(HEAD, 'w-44')}>
                {engine === 'postgres' ? 'Dead rows' : 'Free space'}
              </th>
              <th className={HEAD}>Advice</th>
              <th className={cn(HEAD, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((table) => {
              const advised = tableAdvice(engine, table);
              const severity = advised?.advice.severity ?? 'unknown';
              return (
                <tr key={JSON.stringify(table.table)} className="hover:bg-foreground/[0.02]">
                  <td className={cn(CELL, 'max-w-[16rem]')}>
                    <span className="block truncate font-medium">{tableName(table.table)}</span>
                    {engine === 'postgres' &&
                    (table.lastVacuum || table.lastAnalyze !== undefined) ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {table.lastVacuum
                          ? `Vacuumed ${new Date(table.lastVacuum).toLocaleDateString()}`
                          : 'Never vacuumed'}
                      </span>
                    ) : null}
                  </td>
                  <td className={cn(CELL, 'text-right tabular-nums text-muted-foreground')}>
                    {table.rowEstimate === null ? '' : table.rowEstimate.toLocaleString()}
                  </td>
                  <td
                    className={cn(
                      CELL,
                      'whitespace-nowrap text-right tabular-nums text-muted-foreground',
                    )}
                  >
                    {table.dataBytes === null ? '' : formatBytes(table.dataBytes)}
                  </td>
                  <td
                    className={cn(
                      CELL,
                      'whitespace-nowrap text-right tabular-nums text-muted-foreground',
                    )}
                  >
                    {table.indexBytes === null ? '' : formatBytes(table.indexBytes)}
                  </td>
                  <td className={CELL}>
                    <Meter value={table.freePercent} severity={advised ? severity : 'small'} />
                  </td>
                  <td className={CELL}>
                    {advised ? (
                      <Chip tone={TONE[severity]} title={advised.advice.reason}>
                        {adviceText(engine, 'table', advised.advice, advised.fix)}
                      </Chip>
                    ) : null}
                  </td>
                  <td className={cn(CELL, 'whitespace-nowrap text-right')}>
                    <span className="inline-flex gap-1">
                      {actions.map((one) => (
                        <Button
                          key={one.action}
                          size="xs"
                          shape="pill"
                          variant={advised?.fix === one.action ? 'tint' : 'ghost'}
                          disabled={readOnly}
                          aria-label={`${one.label} ${table.table.name}`}
                          title={readOnly ? 'This connection is read-only' : one.description}
                          onClick={() => onRun(table, one.action)}
                        >
                          {one.label}
                        </Button>
                      ))}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
