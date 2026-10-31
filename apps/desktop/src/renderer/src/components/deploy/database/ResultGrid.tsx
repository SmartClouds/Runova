import type { DbCell, DbResultSet } from '@shared/databaseTypes';
import { ArrowDown, ArrowUp } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * Rows as a table that scrolls both ways under a sticky header. NULL is drawn as a muted word so
 * it never reads like the text "NULL", documents as compact JSON, and long text is cut with the
 * whole value in the tooltip.
 */

const LONG_TEXT = 160;

export function formatCell(cell: DbCell): string {
  if (cell === null) return 'NULL';
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
}

export interface GridSort {
  column: string;
  direction: 'asc' | 'desc';
}

export function ResultGrid({
  label,
  result,
  firstRowNumber = 1,
  sort,
  onSort,
  className,
}: {
  label: string;
  result: DbResultSet;
  firstRowNumber?: number;
  sort?: GridSort | null;
  onSort?: (column: string) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('min-h-0 overflow-auto', className)}>
      <table
        aria-label={label}
        className="w-max min-w-full border-separate border-spacing-0 text-xs"
      >
        <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
          <tr>
            <th
              scope="col"
              className="w-10 border-b border-foreground/[0.08] px-2 py-1.5 text-right font-normal text-muted-foreground/70"
            >
              #
            </th>
            {result.columns.map((column) => {
              const sorted = sort?.column === column.name ? sort.direction : null;
              return (
                <th
                  key={column.name}
                  scope="col"
                  aria-sort={
                    sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                  }
                  className="border-b border-l border-foreground/[0.08] px-0 py-0 text-left font-medium"
                >
                  {onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.name)}
                      aria-label={`Sort by ${column.name}`}
                      className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-foreground/[0.04]"
                    >
                      <ColumnTitle name={column.name} type={column.type} />
                      {sorted === 'asc' ? (
                        <ArrowUp className="h-3 w-3 text-primary" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="h-3 w-3 text-primary" />
                      ) : null}
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5">
                      <ColumnTitle name={column.name} type={column.type} />
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index} className="hover:bg-primary/[0.04]">
              <td className="border-b border-foreground/[0.05] px-2 py-1 text-right font-mono text-[10px] text-muted-foreground/60">
                {firstRowNumber + index}
              </td>
              {row.map((cell, column) => {
                const text = formatCell(cell);
                const long = text.length > LONG_TEXT;
                return (
                  <td
                    key={column}
                    title={long ? text : undefined}
                    className={cn(
                      'max-w-[28rem] truncate border-b border-l border-foreground/[0.05] px-2.5 py-1 font-mono',
                      cell === null && 'italic text-muted-foreground/60',
                      typeof cell === 'number' && 'text-right tabular-nums',
                      typeof cell === 'boolean' && 'text-primary',
                    )}
                  >
                    {long ? `${text.slice(0, LONG_TEXT)}...` : text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && result.columns.length > 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">No rows.</p>
      ) : null}
    </div>
  );
}

function ColumnTitle({ name, type }: { name: string; type: string | null }): React.JSX.Element {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span>{name}</span>
      {type ? (
        <span className="text-[10px] font-normal text-muted-foreground/70">{type}</span>
      ) : null}
    </span>
  );
}
