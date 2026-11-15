import {
  type DbEngine,
  type MaintenanceAction,
  type MaintenanceOptions,
  type MaintenanceTarget,
  maintenanceStatements,
} from '@runova/core';
import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { RunStatementsDialog } from './RunStatementsDialog';

/**
 * Runs index and table upkeep: the engine's rebuild options (Online, fill factor, tempdb sort,
 * concurrently), and the statements they turn into, shown before anything runs.
 */

export interface MaintenanceItem {
  action: MaintenanceAction;
  target: MaintenanceTarget;
}

export interface MaintenanceRequest {
  title: string;
  description?: string;
  /** The run button. */
  action: string;
  items: MaintenanceItem[];
  /** Statements that are not upkeep (adding pgstattuple), used in place of `items`. */
  statements?: string[];
  onDone?: () => void;
}

export function MaintenanceDialog({
  sessionId,
  engine,
  database,
  onlineRebuild,
  request,
  onClose,
}: {
  sessionId: string;
  engine: DbEngine;
  database: string | null;
  /** SQL Server: whether the edition can rebuild online. */
  onlineRebuild: boolean;
  request: MaintenanceRequest | null;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Options
      // A fresh request starts from the defaults again.
      key={request ? `${request.title}:${request.items.length}` : 'none'}
      sessionId={sessionId}
      engine={engine}
      database={database}
      onlineRebuild={onlineRebuild}
      request={request}
      onClose={onClose}
    />
  );
}

function Options({
  sessionId,
  engine,
  database,
  onlineRebuild,
  request,
  onClose,
}: {
  sessionId: string;
  engine: DbEngine;
  database: string | null;
  onlineRebuild: boolean;
  request: MaintenanceRequest | null;
  onClose: () => void;
}): React.JSX.Element {
  const [online, setOnline] = useState(onlineRebuild);
  const [fillFactor, setFillFactor] = useState('');
  const [sortInTempdb, setSortInTempdb] = useState(false);
  const [concurrently, setConcurrently] = useState(true);

  const items = request?.items ?? [];
  const rebuilds = items.filter((item) => item.action === 'rebuild');
  const mssql = engine === 'mssql';
  const postgres = engine === 'postgres';
  const showOnline = mssql && rebuilds.length > 0;
  const showConcurrently = postgres && rebuilds.length > 0;
  const showFill =
    (mssql && rebuilds.some((item) => item.target.scope !== 'heap')) ||
    (postgres && rebuilds.some((item) => item.target.scope === 'index'));
  const showTempdb = mssql && rebuilds.some((item) => item.target.scope !== 'heap');

  const optionsFor = (item: MaintenanceItem): MaintenanceOptions => {
    if (item.action !== 'rebuild') return {};
    const fill = fillFactor.trim() === '' ? null : Number(fillFactor);
    if (mssql) {
      const heap = item.target.scope === 'heap';
      return {
        online: online && onlineRebuild,
        ...(heap ? {} : { fillFactor: fill, sortInTempdb }),
      };
    }
    if (postgres) {
      return {
        concurrently,
        ...(item.target.scope === 'index' ? { fillFactor: fill } : {}),
      };
    }
    return {};
  };

  let statements: string[] = request?.statements ?? [];
  let problem: string | null = null;
  if (request && !request.statements) {
    try {
      statements = items.flatMap((item) =>
        maintenanceStatements(engine, item.action, item.target, optionsFor(item)),
      );
    } catch (error) {
      statements = [];
      problem = error instanceof Error ? error.message : String(error);
    }
  }
  const heavy = items.some((item) => item.action !== 'statistics');
  const anyOptions = showOnline || showConcurrently || showFill || showTempdb;

  return (
    <RunStatementsDialog
      sessionId={sessionId}
      pending={
        request
          ? {
              title: request.title,
              description: request.description,
              statements,
              action: request.action,
              database,
              longRunning: heavy,
              onDone: request.onDone,
            }
          : null
      }
      onClose={onClose}
    >
      {anyOptions ? (
        <fieldset className="space-y-2.5 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.07]">
          <legend className="sr-only">Options</legend>
          {showOnline ? (
            <Toggle
              id="maintenance-online"
              label="Online (the table stays usable while it rebuilds)"
              checked={online && onlineRebuild}
              disabled={!onlineRebuild}
              onChange={setOnline}
              hint={
                onlineRebuild
                  ? online
                    ? undefined
                    : 'Without Online, the table is locked until the rebuild ends.'
                  : 'Online rebuilds need SQL Server Enterprise or Developer edition, or Azure SQL. This one locks the table until it ends.'
              }
            />
          ) : null}
          {showConcurrently ? (
            <Toggle
              id="maintenance-concurrently"
              label="Concurrently (writes carry on while it rebuilds)"
              checked={concurrently}
              onChange={setConcurrently}
              hint={
                concurrently ? undefined : 'Without it, writes to the table wait until it ends.'
              }
            />
          ) : null}
          {showTempdb ? (
            <Toggle
              id="maintenance-tempdb"
              label="Sort in tempdb"
              checked={sortInTempdb}
              onChange={setSortInTempdb}
            />
          ) : null}
          {showFill ? (
            <div className="flex items-center gap-2">
              <label htmlFor="maintenance-fill" className="text-xs">
                Fill factor (%)
              </label>
              <Input
                id="maintenance-fill"
                type="number"
                min={1}
                max={100}
                inputMode="numeric"
                placeholder="Keep"
                value={fillFactor}
                onChange={(event) => setFillFactor(event.target.value)}
                className="h-7 w-24 text-xs"
              />
              <span className="text-[11px] text-muted-foreground">
                Lower leaves room for new rows, at the cost of more pages.
              </span>
            </div>
          ) : null}
        </fieldset>
      ) : null}
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </RunStatementsDialog>
  );
}

function Toggle({
  id,
  label,
  checked,
  disabled,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onChange(value === true)}
        />
        <label htmlFor={id} className={cn('text-xs', disabled && 'text-muted-foreground')}>
          {label}
        </label>
      </div>
      {hint ? <p className="pl-[26px] text-[11px] text-warning">{hint}</p> : null}
    </div>
  );
}
