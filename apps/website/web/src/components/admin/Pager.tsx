import { Button } from '@/components/ui/button';

// The buttons at either end are aria-disabled, not disabled, so focus stays on them.
const EDGE = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

interface PagerProps {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}

/** Previous and next under an admin list, shown only when there is more than one page. */
export function Pager({ page, totalPages, onPage }: PagerProps) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-4">
      <Button
        type="button"
        variant="outline"
        className={EDGE}
        aria-disabled={page <= 1}
        onClick={() => page > 1 && onPage(page - 1)}
      >
        Previous page
      </Button>
      <span className="text-sm">
        Page {page} of {totalPages}
      </span>
      <Button
        type="button"
        variant="outline"
        className={EDGE}
        aria-disabled={page >= totalPages}
        onClick={() => page < totalPages && onPage(page + 1)}
      >
        Next page
      </Button>
    </nav>
  );
}
