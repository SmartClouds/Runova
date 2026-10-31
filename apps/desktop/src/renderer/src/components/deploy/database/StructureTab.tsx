import type { DbObjectRef, DbTableDescription } from '@shared/databaseTypes';
import { useQuery } from '@tanstack/react-query';
import { Key, Pencil } from '@/components/icons';
import { Notice, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CODE_WELL } from '../security/SecurityCard';

/** A table's columns, its indexes and, where the engine can say, the statement that makes it. */
export function StructureTab({
  sessionId,
  objectRef,
  onEditColumns,
}: {
  sessionId: string;
  objectRef: DbObjectRef;
  /** Opens the designer on this table. Left out where the engine cannot change columns. */
  onEditColumns?: (table: DbTableDescription) => void;
}): React.JSX.Element {
  const table = useQuery({
    queryKey: queryKeys.databaseTable(sessionId, JSON.stringify(objectRef)),
    queryFn: () => window.runova.database.describe(sessionId, objectRef),
    retry: false,
  });

  if (table.isPending) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (table.isError) {
    return (
      <Notice tone="destructive" size="sm" className="m-3">
        {table.error instanceof Error ? table.error.message : 'Could not read the structure.'}
      </Notice>
    );
  }
  const { columns, indexes, definition, rowEstimate } = table.data;
  const cell = 'border-b border-foreground/[0.05] px-3 py-1.5';
  return (
    <div className="h-full space-y-5 overflow-auto p-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className={SECTION_HEADING}>
            Columns{rowEstimate !== null ? ` · about ${rowEstimate.toLocaleString()} rows` : ''}
          </h4>
          {onEditColumns && table.data.kind === 'table' ? (
            <Button size="xs" shape="pill" variant="soft" onClick={() => onEditColumns(table.data)}>
              <Pencil /> Edit columns
            </Button>
          ) : null}
        </div>
        <table aria-label="Columns" className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className={cn(cell, 'font-medium')}>Name</th>
              <th className={cn(cell, 'font-medium')}>Type</th>
              <th className={cn(cell, 'font-medium')}>Null</th>
              <th className={cn(cell, 'font-medium')}>Default</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.name}>
                <td className={cn(cell, 'font-medium')}>
                  <span className="flex items-center gap-1.5">
                    {column.primaryKey ? (
                      <Key className="h-3 w-3 text-warning" aria-label="Primary key" />
                    ) : null}
                    {column.name}
                    {column.generated ? (
                      <span className="rounded bg-foreground/[0.06] px-1 text-[10px] text-muted-foreground">
                        auto
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className={cn(cell, 'font-mono text-muted-foreground')}>{column.type}</td>
                <td className={cell}>{column.nullable ? 'yes' : 'no'}</td>
                <td className={cn(cell, 'max-w-[18rem] truncate font-mono text-muted-foreground')}>
                  {column.defaultValue ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {indexes.length > 0 ? (
        <section className="space-y-2">
          <h4 className={SECTION_HEADING}>Indexes</h4>
          <ul className="space-y-1 text-xs">
            {indexes.map((index) => (
              <li key={index.name} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{index.name}</span>
                <span className="font-mono text-muted-foreground">
                  ({index.columns.join(', ')})
                </span>
                {index.primary ? (
                  <span className="rounded-full bg-warning/12 px-1.5 text-[10px] text-warning">
                    primary
                  </span>
                ) : index.unique ? (
                  <span className="rounded-full bg-primary/12 px-1.5 text-[10px] text-primary">
                    unique
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {definition ? (
        <section className="space-y-2">
          <h4 className={SECTION_HEADING}>Definition</h4>
          <pre className={CODE_WELL}>{definition}</pre>
        </section>
      ) : null}
    </div>
  );
}
