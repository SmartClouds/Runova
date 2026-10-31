import type { DbEngine } from '@runova/core';
import type { DbObjectRef, DbResultSet } from '@shared/databaseTypes';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Filter, Plus, RefreshCw } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { formatCell, type GridSort, ResultGrid } from './ResultGrid';
import { AddRowDialog, ReviewChangesDialog, useRowChanges } from './RowChanges';

/**
 * One table's rows, a page at a time: sort by a column, filter with a condition, step through
 * pages, and save what is shown as CSV.
 */

const PAGE = 100;

function refLabel(ref: DbObjectRef): string {
  return [ref.schema, ref.name].filter(Boolean).join('.');
}

export function toCsv(result: DbResultSet): string {
  const quote = (text: string) =>
    /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  const lines = [result.columns.map((column) => quote(column.name)).join(',')];
  for (const row of result.rows) {
    lines.push(row.map((cell) => (cell === null ? '' : quote(formatCell(cell)))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataTab({
  sessionId,
  engine,
  readOnly,
  objectRef,
}: {
  sessionId: string;
  engine: DbEngine;
  readOnly: boolean;
  objectRef: DbObjectRef;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sort, setSort] = useState<GridSort | null>(null);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const label = refLabel(objectRef);

  const rows = useQuery({
    queryKey: queryKeys.databaseRows(
      sessionId,
      JSON.stringify(objectRef),
      JSON.stringify({ offset, sort, filter }),
    ),
    queryFn: () =>
      window.runova.database.readRows({
        sessionId,
        ref: objectRef,
        limit: PAGE,
        offset,
        ...(filter ? { filter } : {}),
        ...(sort ? { orderBy: sort } : {}),
      }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const table = useQuery({
    queryKey: queryKeys.databaseTable(sessionId, JSON.stringify(objectRef)),
    queryFn: () => window.runova.database.describe(sessionId, objectRef),
    retry: false,
    enabled: !readOnly,
  });
  const columnTypes = useMemo(
    () => new Map((table.data?.columns ?? []).map((column) => [column.name, column.type])),
    [table.data],
  );
  const keyColumns = rows.data?.keyColumns ?? [];
  const changes = useRowChanges(engine, objectRef, keyColumns, columnTypes);
  const editable = !readOnly && keyColumns.length > 0 && table.data?.kind === 'table';
  const pending = changes.count > 0;
  const review = rows.data ? changes.statements(rows.data.result) : { sql: '', error: null };

  async function apply() {
    setApplying(true);
    setProblem(null);
    try {
      const outcome = await window.runova.database.query({
        sessionId,
        queryId: `edits-${Date.now().toString(36)}`,
        text: review.sql,
        database: objectRef.database ?? null,
        confirmed: true,
      });
      if (outcome.status === 'failed') {
        setProblem(`Nothing was changed. ${outcome.error}`);
        return;
      }
      changes.clear();
      setReviewing(false);
      await queryClient.invalidateQueries({ queryKey: ['database', 'session', sessionId, 'rows'] });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  }

  const toggleSort = (column: string) => {
    if (pending) return;
    setOffset(0);
    setSort((current) =>
      current?.column !== column
        ? { column, direction: 'asc' }
        : current.direction === 'asc'
          ? { column, direction: 'desc' }
          : null,
    );
  };

  const page = rows.data;
  const shown = page?.result.rows.length ?? 0;
  const total = page?.total ?? null;
  const hasNext = total !== null ? offset + shown < total : shown === PAGE;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-foreground/[0.06] px-3 py-2">
        {engine === 'redis' ? (
          <p className="flex-1 text-xs text-muted-foreground">
            {page?.result.statement.split(' ')[0] ?? 'Key'} contents
          </p>
        ) : (
          <form
            className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-lg bg-foreground/[0.04] px-2.5 ring-1 ring-inset ring-foreground/[0.06] focus-within:ring-primary/40"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending) return;
              setOffset(0);
              setFilter(draft.trim());
            }}
          >
            <Filter className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="font-mono text-[11px] text-muted-foreground">
              {engine === 'mongodb' ? 'find' : 'WHERE'}
            </span>
            <input
              aria-label="Filter rows"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={
                engine === 'mongodb'
                  ? '{ status: "paid", total: { $gt: 10 } }'
                  : "total > 10 AND status = 'paid'"
              }
              spellCheck={false}
              className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/50"
            />
          </form>
        )}
        {editable ? (
          <Button size="sm" shape="pill" variant="soft" onClick={() => setAdding(true)}>
            <Plus /> Add row
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Reload rows"
          onClick={() => void rows.refetch()}
          disabled={rows.isFetching}
        >
          <RefreshCw className={cn(rows.isFetching && 'animate-spin')} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Save this page as CSV"
          disabled={!page}
          onClick={() => page && download(objectRef.name, toCsv(page.result))}
        >
          <Download />
        </Button>
      </div>

      {rows.isError ? (
        <Notice tone="destructive" size="sm" className="m-3">
          {rows.error instanceof Error ? rows.error.message : 'Could not read the rows.'}
        </Notice>
      ) : null}

      {rows.isPending ? (
        <div className="space-y-1.5 p-3" aria-busy="true">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      ) : page ? (
        <ResultGrid
          label={label}
          result={page.result}
          firstRowNumber={offset + 1}
          sort={sort}
          onSort={toggleSort}
          edit={editable ? changes.edit : undefined}
          className={cn('flex-1', rows.isFetching && 'opacity-70')}
        />
      ) : null}

      {pending ? (
        <div className="flex items-center gap-2 border-t border-warning/30 bg-warning/[0.08] px-3 py-1.5 text-xs">
          <span className="font-medium">
            {changes.count} {changes.count === 1 ? 'change' : 'changes'} not saved yet
          </span>
          <Button
            size="xs"
            shape="pill"
            variant="ghost"
            className="ml-auto"
            onClick={changes.clear}
          >
            Discard
          </Button>
          <Button
            size="xs"
            shape="pill"
            onClick={() => {
              setProblem(null);
              setReviewing(true);
            }}
          >
            Review and apply
          </Button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-foreground/[0.06] px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {total !== null
            ? `${total.toLocaleString()} ${total === 1 ? 'row' : 'rows'}`
            : shown > 0
              ? `Rows ${offset + 1} to ${offset + shown}`
              : ''}
          {page && page.keyColumns.length === 0 && !readOnly
            ? ' · no primary key, so rows cannot be edited here'
            : ''}
          {editable && !pending ? ' · double-click a cell to edit it' : ''}
        </span>
        <span className="ml-auto tabular-nums">
          {shown > 0 ? `${offset + 1} to ${offset + shown}` : null}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous page"
          disabled={offset === 0 || rows.isFetching || pending}
          onClick={() => setOffset(Math.max(0, offset - PAGE))}
        >
          <ChevronLeft />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next page"
          disabled={!hasNext || rows.isFetching || pending}
          onClick={() => setOffset(offset + PAGE)}
        >
          <ChevronRight />
        </Button>
      </div>
      <ReviewChangesDialog
        open={reviewing}
        sql={review.sql}
        error={review.error}
        busy={applying}
        problem={problem}
        onApply={() => void apply()}
        onClose={() => setReviewing(false)}
      />
      <AddRowDialog
        open={adding}
        table={table.data}
        onAdd={(values) => {
          changes.addInsert(values);
          setAdding(false);
        }}
        onClose={() => setAdding(false)}
      />
    </div>
  );
}
