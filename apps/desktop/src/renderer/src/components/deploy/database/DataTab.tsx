import type { DbObjectRef, DbResultSet } from '@shared/databaseTypes';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Filter, RefreshCw } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { formatCell, type GridSort, ResultGrid } from './ResultGrid';

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
  objectRef,
}: {
  sessionId: string;
  objectRef: DbObjectRef;
}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
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

  const toggleSort = (column: string) => {
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
        <form
          className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-lg bg-foreground/[0.04] px-2.5 ring-1 ring-inset ring-foreground/[0.06] focus-within:ring-primary/40"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setFilter(draft.trim());
          }}
        >
          <Filter className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[11px] text-muted-foreground">WHERE</span>
          <input
            aria-label="Filter rows"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="total > 10 AND status = 'paid'"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/50"
          />
        </form>
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
          className={cn('flex-1', rows.isFetching && 'opacity-70')}
        />
      ) : null}

      <div className="flex items-center gap-2 border-t border-foreground/[0.06] px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {total !== null
            ? `${total.toLocaleString()} ${total === 1 ? 'row' : 'rows'}`
            : shown > 0
              ? `Rows ${offset + 1} to ${offset + shown}`
              : ''}
          {page && page.keyColumns.length === 0 ? ' · no primary key' : ''}
        </span>
        <span className="ml-auto tabular-nums">
          {shown > 0 ? `${offset + 1} to ${offset + shown}` : null}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous page"
          disabled={offset === 0 || rows.isFetching}
          onClick={() => setOffset(Math.max(0, offset - PAGE))}
        >
          <ChevronLeft />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next page"
          disabled={!hasNext || rows.isFetching}
          onClick={() => setOffset(offset + PAGE)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
