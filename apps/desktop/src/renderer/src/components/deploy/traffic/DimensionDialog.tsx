import { coreErrorMessage } from '@shared/coreErrors';
import type { TrafficDimension } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { compactNumber } from '@shared/deploy/trafficFormat';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { breakdownRows } from '@/lib/deploy/traffic/geometry';
import { catchAllsLast } from '@/lib/deploy/traffic/report';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { BreakdownRows } from './BreakdownCard';
import { DIMENSION_TITLES, DIMENSION_UNITS } from './messages';

const PAGE = 50;
const SEARCH_DELAY_MS = 250;

/**
 * Every value of one breakdown over the report's range, behind "See all": a page at a time from
 * the core, with a search the core runs (so it finds values beyond the first page too).
 */
export function DimensionDialog({
  serverId,
  siteId,
  range,
  dimension,
  onClose,
}: {
  serverId: string;
  siteId: string | null;
  range: { fromUnixMs: number; toUnixMs: number };
  dimension: TrafficDimension;
  onClose: () => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    // Only a search that changed goes back to the first page, so paging is never undone.
    const next = typed.trim();
    if (next === search) return undefined;
    const timer = setTimeout(() => {
      setSearch(next);
      setOffset(0);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, search]);

  const view = { siteId, ...range, dimension, offset, search };
  const page = useQuery({
    queryKey: queryKeys.deployTrafficDimension(serverId, view),
    queryFn: () =>
      window.runova.deployTraffic.dimension({
        serverId,
        ...(siteId ? { siteId } : {}),
        ...range,
        dimension,
        offset,
        limit: PAGE,
        ...(search ? { search } : {}),
      }),
    retry: false,
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
  const rows = useMemo(
    () =>
      page.data ? breakdownRows(catchAllsLast(page.data.items, dimension), page.data.total) : [],
    [page.data, dimension],
  );
  const title = DIMENSION_TITLES[dimension];
  const totalItems = page.data?.totalItems ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Every value in this range, by {DIMENSION_UNITS[dimension]}.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder="Search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="pl-8"
          />
        </div>
        <div
          className={cn(
            'max-h-[55vh] min-h-40 overflow-y-auto transition-opacity',
            page.isPlaceholderData && 'opacity-50',
          )}
        >
          {page.isPending ? (
            <div className="space-y-1.5" aria-busy="true">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-7 w-full" />
              ))}
            </div>
          ) : page.isError ? (
            <p role="alert" className="py-6 text-center text-sm text-muted-foreground">
              {coreErrorMessage(page.error)}
            </p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {search ? `Nothing matches “${search}”.` : 'Nothing in this range.'}
            </p>
          ) : (
            <BreakdownRows dimension={dimension} rows={rows} label={title} />
          )}
        </div>
        {totalItems > PAGE && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {offset + 1} to {Math.min(offset + PAGE, totalItems)} of {compactNumber(totalItems)}
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="soft"
                disabled={offset === 0}
                onClick={() => setOffset((current) => Math.max(0, current - PAGE))}
              >
                <ChevronLeft /> Back
              </Button>
              <Button
                size="sm"
                variant="soft"
                disabled={offset + PAGE >= totalItems}
                onClick={() => setOffset((current) => current + PAGE)}
              >
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
