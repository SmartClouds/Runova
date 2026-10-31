import {
  buildAlterTable,
  buildCreateTable,
  type ColumnDraft,
  columnTypeSuggestions,
  type DbEngine,
  engineInfo,
} from '@runova/core';
import type { DbObjectRef, DbTableDescription } from '@shared/databaseTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState } from 'react';
import { Plus, Table, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CODE_WELL } from '../security/SecurityCard';

/**
 * Making a table, or changing one's columns, without writing SQL: one row per column, and the
 * exact statement it turns into right underneath, which is what runs.
 */

export type DesignerTarget =
  | { mode: 'create'; where: Omit<DbObjectRef, 'name'> }
  | { mode: 'edit'; table: DbTableDescription };

interface Row extends ColumnDraft {
  key: string;
}

let rowKey = 0;
const nextKey = () => `col-${rowKey++}`;

function starterColumns(engine: DbEngine): Row[] {
  const types = columnTypeSuggestions(engine);
  if (engine === 'mongodb') {
    return [{ key: nextKey(), name: 'name', type: 'string', nullable: false, primaryKey: false }];
  }
  if (engine === 'cassandra') {
    return [
      { key: nextKey(), name: 'id', type: 'uuid', nullable: false, primaryKey: true },
      { key: nextKey(), name: 'name', type: 'text', nullable: true, primaryKey: false },
    ];
  }
  return [
    {
      key: nextKey(),
      name: 'id',
      type: engine === 'sqlite' ? 'INTEGER' : (types[0] ?? 'integer'),
      nullable: false,
      primaryKey: true,
      autoIncrement: true,
    },
    {
      key: nextKey(),
      name: 'name',
      type: engine === 'sqlite' ? 'TEXT' : engine === 'mssql' ? 'nvarchar(255)' : 'text',
      nullable: true,
      primaryKey: false,
    },
  ];
}

function fromTable(table: DbTableDescription): Row[] {
  return table.columns.map((column) => ({
    key: nextKey(),
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    primaryKey: column.primaryKey,
    autoIncrement: column.generated,
    defaultValue: column.defaultValue,
    originalName: column.name,
  }));
}

export function TableDesigner({
  sessionId,
  engine,
  target,
  onClose,
}: {
  sessionId: string;
  engine: DbEngine;
  target: DesignerTarget | null;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const listId = useId();
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const info = engineInfo(engine);
  const isMongo = engine === 'mongodb';
  const canAutoIncrement = engine !== 'cassandra' && !isMongo;

  useEffect(() => {
    if (!target) return;
    setProblem(null);
    if (target.mode === 'create') {
      setName('');
      setRows(starterColumns(engine));
    } else {
      setName(target.table.ref.name);
      setRows(fromTable(target.table));
    }
  }, [target, engine]);

  const preview = useMemo((): { sql: string; error: string | null } => {
    if (!target) return { sql: '', error: null };
    try {
      if (target.mode === 'create') {
        if (!name.trim()) return { sql: '', error: `Name the ${info.objectNoun}.` };
        return {
          sql: buildCreateTable(engine, {
            ref: { ...target.where, name: name.trim() },
            columns: rows,
          }),
          error: null,
        };
      }
      const statements = buildAlterTable(engine, target.table.ref, fromTable(target.table), rows);
      return {
        sql: statements.join('\n'),
        error: statements.length === 0 ? 'Nothing has changed yet.' : null,
      };
    } catch (error) {
      return { sql: '', error: error instanceof Error ? error.message : String(error) };
    }
  }, [target, name, rows, engine, info.objectNoun]);

  const update = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  async function apply() {
    if (!preview.sql) return;
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await window.runova.database.query({
        sessionId,
        queryId: `designer-${Date.now().toString(36)}`,
        text: preview.sql,
        database:
          (target?.mode === 'create' ? target.where.database : target?.table.ref.database) ?? null,
        confirmed: true,
      });
      if (outcome.status === 'failed') {
        setProblem(outcome.error);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.databaseSession(sessionId) });
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const creating = target?.mode === 'create';
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table className="h-4 w-4 text-primary" />
            {creating ? `New ${info.objectNoun}` : `Columns of ${name}`}
          </DialogTitle>
          <DialogDescription>
            {creating
              ? `Add the columns it needs. The ${info.label} statement below is exactly what runs.`
              : 'Rename, retype, add or remove columns. Removing a column deletes its data.'}
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <div className="space-y-1.5">
            <Label htmlFor="designer-name">Name</Label>
            <Input
              id="designer-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={isMongo ? 'orders' : 'orders'}
              autoFocus
              className="max-w-sm"
            />
          </div>
        ) : null}

        <div className="max-h-[40vh] overflow-auto rounded-xl ring-1 ring-inset ring-foreground/[0.07]">
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">Column</th>
                <th className="px-2 py-1.5 font-medium">{isMongo ? 'BSON type' : 'Type'}</th>
                <th className="px-2 py-1.5 text-center font-medium">Null</th>
                {isMongo ? null : <th className="px-2 py-1.5 text-center font-medium">Key</th>}
                {canAutoIncrement ? (
                  <th className="px-2 py-1.5 text-center font-medium">Auto</th>
                ) : null}
                {engine === 'cassandra' || isMongo ? null : (
                  <th className="px-2 py-1.5 font-medium">Default</th>
                )}
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key} className="align-middle">
                  <td className="px-1.5 py-1">
                    <Input
                      aria-label={`Column ${index + 1} name`}
                      value={row.name}
                      onChange={(event) => update(row.key, { name: event.target.value })}
                      className="h-8 font-mono text-xs"
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <Input
                      aria-label={`Column ${index + 1} type`}
                      value={row.type}
                      list={listId}
                      onChange={(event) => update(row.key, { type: event.target.value })}
                      className="h-8 font-mono text-xs"
                    />
                  </td>
                  <td className="px-1.5 py-1 text-center">
                    <Checkbox
                      aria-label={`Column ${index + 1} can be empty`}
                      checked={row.nullable}
                      onCheckedChange={(value) => update(row.key, { nullable: value === true })}
                    />
                  </td>
                  {isMongo ? null : (
                    <td className="px-1.5 py-1 text-center">
                      <Checkbox
                        aria-label={`Column ${index + 1} is in the primary key`}
                        checked={row.primaryKey}
                        onCheckedChange={(value) =>
                          update(row.key, {
                            primaryKey: value === true,
                            ...(value === true ? { nullable: false } : {}),
                          })
                        }
                      />
                    </td>
                  )}
                  {canAutoIncrement ? (
                    <td className="px-1.5 py-1 text-center">
                      <Checkbox
                        aria-label={`Column ${index + 1} counts up by itself`}
                        checked={row.autoIncrement === true}
                        onCheckedChange={(value) =>
                          update(row.key, { autoIncrement: value === true })
                        }
                      />
                    </td>
                  ) : null}
                  {engine === 'cassandra' || isMongo ? null : (
                    <td className="px-1.5 py-1">
                      <Input
                        aria-label={`Column ${index + 1} default`}
                        value={row.defaultValue ?? ''}
                        onChange={(event) =>
                          update(row.key, { defaultValue: event.target.value || null })
                        }
                        placeholder="none"
                        className="h-8 font-mono text-xs"
                      />
                    </td>
                  )}
                  <td className="px-1 py-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove column ${row.name || index + 1}`}
                      onClick={() =>
                        setRows((current) => current.filter((one) => one.key !== row.key))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id={listId}>
            {columnTypeSuggestions(engine).map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </div>
        <Button
          size="sm"
          shape="pill"
          variant="soft"
          className="self-start"
          onClick={() =>
            setRows((current) => [
              ...current,
              {
                key: nextKey(),
                name: '',
                type: columnTypeSuggestions(engine)[2] ?? 'text',
                nullable: true,
                primaryKey: false,
              },
            ])
          }
        >
          <Plus /> Add a column
        </Button>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">What runs</p>
          {preview.sql ? (
            <pre
              aria-label="Statement preview"
              className={cn(CODE_WELL, 'max-h-48 whitespace-pre-wrap')}
            >
              {preview.sql}
            </pre>
          ) : null}
          {preview.error ? <p className="text-xs text-muted-foreground">{preview.error}</p> : null}
          {problem ? (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={busy || !preview.sql}>
            {creating ? `Create ${info.objectNoun}` : 'Apply changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
