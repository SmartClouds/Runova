import type { DbCell, DbResultSet } from '@shared/databaseTypes';
import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from '@/components/icons';
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

/** Editing in place: cells change on double click, rows can be marked for deletion. */
export interface GridEdit {
  /** The pending value of a cell, or undefined when it has not been changed. */
  pending: (row: number, column: string) => DbCell | undefined;
  onChange: (row: number, column: string, value: DbCell) => void;
  deleted: ReadonlySet<number>;
  onToggleDelete: (row: number) => void;
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
  edit,
  className,
}: {
  label: string;
  result: DbResultSet;
  firstRowNumber?: number;
  sort?: GridSort | null;
  onSort?: (column: string) => void;
  edit?: GridEdit;
  className?: string;
}): React.JSX.Element {
  const [editing, setEditing] = useState<{ row: number; column: number } | null>(null);
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
            <tr
              key={index}
              className={cn(
                'group/row hover:bg-primary/[0.04]',
                edit?.deleted.has(index) && 'bg-destructive/[0.06] line-through opacity-70',
              )}
            >
              <td className="border-b border-foreground/[0.05] px-2 py-1 text-right font-mono text-[10px] text-muted-foreground/60">
                {edit ? (
                  <button
                    type="button"
                    aria-label={`${edit.deleted.has(index) ? 'Keep' : 'Delete'} row ${firstRowNumber + index}`}
                    onClick={() => edit.onToggleDelete(index)}
                    className="w-full text-right hover:text-destructive"
                  >
                    <span className="group-hover/row:hidden">{firstRowNumber + index}</span>
                    <Trash2 className="ml-auto hidden h-3 w-3 group-hover/row:block" />
                  </button>
                ) : (
                  firstRowNumber + index
                )}
              </td>
              {row.map((original, column) => {
                const name = result.columns[column]?.name ?? '';
                const changed = edit?.pending(index, name);
                const cell = changed === undefined ? original : changed;
                const text = formatCell(cell);
                const long = text.length > LONG_TEXT;
                if (edit && editing?.row === index && editing.column === column) {
                  return (
                    <td key={column} className="border-b border-l border-primary/40 p-0">
                      <CellEditor
                        label={`Edit ${name}`}
                        value={cell}
                        onDone={(value) => {
                          setEditing(null);
                          if (value !== undefined && formatCell(value) !== formatCell(original)) {
                            edit.onChange(index, name, value);
                          } else if (value !== undefined && changed !== undefined) {
                            edit.onChange(index, name, original);
                          }
                        }}
                      />
                    </td>
                  );
                }
                return (
                  <td
                    key={column}
                    title={long ? text : undefined}
                    onDoubleClick={edit ? () => setEditing({ row: index, column }) : undefined}
                    className={cn(
                      'max-w-[28rem] truncate border-b border-l border-foreground/[0.05] px-2.5 py-1 font-mono',
                      cell === null && 'italic text-muted-foreground/60',
                      typeof cell === 'number' && 'text-right tabular-nums',
                      typeof cell === 'boolean' && 'text-primary',
                      changed !== undefined && 'bg-warning/12 text-foreground',
                      edit && 'cursor-text',
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

/** A cell being edited: Enter keeps it, Escape drops it, and NULL is one click. */
function CellEditor({
  label,
  value,
  onDone,
}: {
  label: string;
  value: DbCell;
  onDone: (value: DbCell | undefined) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value === null ? '' : formatCell(value));
  const parse = (): DbCell => {
    if (value !== null && typeof value === 'object') {
      try {
        return JSON.parse(text) as DbCell;
      } catch {
        return text;
      }
    }
    return text;
  };
  return (
    <div className="flex items-center gap-1 bg-background px-1">
      <input
        aria-label={label}
        value={text}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onDone(parse());
          if (event.key === 'Escape') onDone(undefined);
        }}
        onBlur={() => onDone(parse())}
        className="h-6 min-w-[8rem] flex-1 bg-transparent font-mono text-xs outline-none"
      />
      <button
        type="button"
        onMouseDown={(event) => {
          event.preventDefault();
          onDone(null);
        }}
        className="rounded px-1 text-[10px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
      >
        NULL
      </button>
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
