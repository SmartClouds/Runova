import { buildRowEdits, type DbEngine, type RowEdit } from '@runova/core';
import type { DbCell, DbObjectRef, DbResultSet, DbTableDescription } from '@shared/databaseTypes';
import { useMemo, useState } from 'react';
import { Plus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { CODE_WELL } from '../security/SecurityCard';
import type { GridEdit } from './ResultGrid';

/**
 * The grid's pending changes: edited cells, rows marked for deletion and new rows. Nothing is
 * written until the user reviews the statements, which then run in one transaction.
 */

export interface RowChanges {
  edit: GridEdit;
  inserts: Record<string, DbCell>[];
  addInsert: (values: Record<string, DbCell>) => void;
  count: number;
  /** The statements for everything pending, or the reason they cannot be written. */
  statements: (result: DbResultSet) => { sql: string; error: string | null };
  clear: () => void;
}

export function useRowChanges(
  engine: DbEngine,
  ref: DbObjectRef,
  keyColumns: readonly string[],
  columnTypes: ReadonlyMap<string, string>,
): RowChanges {
  const [cells, setCells] = useState<Map<number, Record<string, DbCell>>>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [inserts, setInserts] = useState<Record<string, DbCell>[]>([]);

  const edit: GridEdit = {
    pending: (row, column) => {
      const changed = cells.get(row);
      return changed && column in changed ? changed[column] : undefined;
    },
    onChange: (row, column, value) =>
      setCells((current) => {
        const next = new Map(current);
        next.set(row, { ...(next.get(row) ?? {}), [column]: value });
        return next;
      }),
    deleted,
    onToggleDelete: (row) =>
      setDeleted((current) => {
        const next = new Set(current);
        if (next.has(row)) next.delete(row);
        else next.add(row);
        return next;
      }),
  };

  const statements = (result: DbResultSet) => {
    const index = new Map(result.columns.map((column, position) => [column.name, position]));
    const keyOf = (row: number): Record<string, unknown> =>
      Object.fromEntries(
        keyColumns.map((name) => [name, result.rows[row]?.[index.get(name) ?? -1] ?? null]),
      );
    const edits: RowEdit[] = [];
    for (const [row, values] of cells) {
      if (!deleted.has(row)) edits.push({ kind: 'update', key: keyOf(row), values });
    }
    for (const values of inserts) edits.push({ kind: 'insert', values });
    for (const row of deleted) edits.push({ kind: 'delete', key: keyOf(row) });
    const columns = result.columns.map((column) => ({
      name: column.name,
      type: columnTypes.get(column.name) ?? column.type,
    }));
    try {
      return { sql: buildRowEdits(engine, ref, columns, edits), error: null };
    } catch (error) {
      return { sql: '', error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    edit,
    inserts,
    addInsert: (values) => setInserts((current) => [...current, values]),
    count: cells.size + deleted.size + inserts.length,
    statements,
    clear: () => {
      setCells(new Map());
      setDeleted(new Set());
      setInserts([]);
    },
  };
}

export function ReviewChangesDialog({
  open,
  sql,
  error,
  busy,
  problem,
  onApply,
  onClose,
}: {
  open: boolean;
  sql: string;
  error: string | null;
  busy: boolean;
  problem: string | null;
  onApply: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review the changes</DialogTitle>
          <DialogDescription>
            These statements run together: if one fails, none of them is kept.
          </DialogDescription>
        </DialogHeader>
        {sql ? (
          <pre
            aria-label="Changes to apply"
            className={cn(CODE_WELL, 'max-h-[50vh] whitespace-pre-wrap')}
          >
            {sql}
          </pre>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {problem ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep editing
          </Button>
          <Button onClick={onApply} disabled={busy || !sql}>
            Apply changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A form with one field per column. A field left empty is left out, so its default applies. */
export function AddRowDialog({
  open,
  table,
  onAdd,
  onClose,
}: {
  open: boolean;
  table: DbTableDescription | undefined;
  onAdd: (values: Record<string, DbCell>) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const columns = useMemo(() => table?.columns ?? [], [table]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setValues({});
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const filled = Object.fromEntries(
              Object.entries(values).filter(([, value]) => value !== ''),
            ) as Record<string, DbCell>;
            onAdd(filled);
            setValues({});
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-primary" /> Add a row
            </DialogTitle>
            <DialogDescription>
              Leave a field empty to use its default. The row is added when you apply the changes.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2.5 overflow-auto pr-1">
            {columns.map((column) => (
              <div key={column.name} className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <Label htmlFor={`add-row-${column.name}`} className="truncate font-mono text-xs">
                  {column.name}
                  <span className="ml-1 font-sans text-[10px] text-muted-foreground">
                    {column.type}
                  </span>
                </Label>
                <Input
                  id={`add-row-${column.name}`}
                  value={values[column.name] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [column.name]: event.target.value }))
                  }
                  placeholder={
                    column.generated
                      ? 'set by the database'
                      : (column.defaultValue ?? (column.nullable ? 'NULL' : ''))
                  }
                  className="h-8 font-mono text-xs"
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Add row</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
