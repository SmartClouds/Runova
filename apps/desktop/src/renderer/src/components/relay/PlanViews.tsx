import {
  bodySection,
  RELAY_ITEM_SPECS,
  type RelayItem,
  type RelayItemKind,
  type RelayRevisit,
} from '@runova/core';
import type { RelayBoard, RelayPlanPack, RelayTaskCard } from '@shared/relayTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Wand2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  filterTasks,
  isOverdue,
  milestoneRows,
  NO_FILTER,
  PRIORITY_WORDS,
  type Progress,
  progressOf,
  SIZE_WORDS,
  sortTasks,
  type TaskFilter,
  type TaskSortKey,
  todayString,
} from './planView';
import { RelayItemDialog } from './RelayItemDialog';
import { columnSpec } from './relayView';
import { useRevisits } from './usePlanPack';

function ProgressBar({ progress, label }: { progress: Progress; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${progress.percent}%` }} />
      </div>
      <span className="w-20 text-right text-[11px] text-muted-foreground tabular-nums">
        {progress.done} of {progress.total}
      </span>
    </div>
  );
}

function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-foreground/[0.07] ring-inset"
    >
      <header className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        <div className="ml-auto">{action}</div>
      </header>
      {children}
    </section>
  );
}

function StatusChip({ status }: { status: RelayTaskCard['status'] }) {
  const column = columnSpec(status);
  return (
    <span
      className="rounded-full px-1.5 py-px text-[10px] whitespace-nowrap"
      style={{ background: `hsl(${column.tone} / 0.15)`, color: `hsl(${column.tone})` }}
    >
      {column.label}
    </span>
  );
}

/**
 * Two files with one id, usually after a pull from another computer. Either file can take the next
 * free id; whatever names the old id keeps pointing at the other one.
 */
function DuplicateIds({
  projectId,
  duplicates,
}: {
  projectId: string;
  duplicates: { id: string; files: string[] }[];
}) {
  const queryClient = useQueryClient();
  async function renumber(file: string): Promise<void> {
    try {
      const id = await window.runova.relay.renumber(projectId, file);
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayPlanPack(projectId) });
      toast.success(`${file} is ${id} now`, {
        description: 'Check what named the old id, and point it at the right one.',
      });
    } catch (error) {
      toast.error('Could not give it a new id', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return (
    <section
      aria-label="Duplicate ids"
      className="rounded-xl bg-warning/10 p-3 text-xs ring-1 ring-warning/30 ring-inset"
    >
      <p className="mb-2 font-medium">
        Two files share an id, often after a pull from another computer.
      </p>
      <ul className="space-y-1.5">
        {duplicates.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono">{entry.id}</span>
            {entry.files.slice(1).map((file) => (
              <Button
                key={file}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void renumber(file)}
              >
                Give {file} a new id
              </Button>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

const REVISIT_WORDS: Record<RelayRevisit['state'], string> = {
  ready: 'Ready to revisit',
  due: 'Due for a look',
  waiting: 'Waiting',
  unknown: 'Nothing to check',
};

/** The plan at a glance: its goal, progress overall and by milestone, and what needs attention. */
export function RelayOverview({
  board,
  pack,
  onSelectTask,
  onEditPlan,
}: {
  board: RelayBoard;
  pack: RelayPlanPack | undefined;
  onSelectTask: (taskId: string) => void;
  onEditPlan: () => void;
}): React.JSX.Element {
  const revisits = useRevisits(board.projectId, true);
  const today = todayString();
  const overall = progressOf(board.tasks);
  const rows = milestoneRows(board.tasks, pack?.items.milestone ?? []);
  const blocked = board.tasks.filter((task) => task.status === 'blocked');
  const testing = board.tasks.filter((task) => task.status === 'testing');
  const overdue = board.tasks.filter(
    (task) => task.status !== 'done' && isOverdue(task.due, today),
  );
  const openQuestions = (pack?.items.question ?? []).filter((item) => item.status === 'open');
  const risks = (pack?.items.risk ?? []).filter((item) => item.status === 'open');
  const ready = (revisits.data ?? []).filter(
    (entry) => entry.state === 'ready' || entry.state === 'due',
  );
  const recent = [...board.tasks]
    .filter((task) => task.finished)
    .sort((a, b) => (b.finished ?? '').localeCompare(a.finished ?? ''))
    .slice(0, 5);
  const plan = pack?.plan ?? null;
  const goal = plan ? bodySection(plan.body, 'Goal') : '';

  const taskLink = (task: RelayTaskCard) => (
    <li key={task.id}>
      <button
        type="button"
        onClick={() => onSelectTask(task.id)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-foreground/[0.05]"
      >
        <span className="font-mono text-[11px] text-muted-foreground">{task.id}</span>
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        <StatusChip status={task.status} />
      </button>
    </li>
  );

  return (
    <div aria-label="Overview" className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      {(pack?.duplicates ?? []).length > 0 ? (
        <DuplicateIds projectId={board.projectId} duplicates={pack?.duplicates ?? []} />
      ) : null}
      <Panel
        title={plan?.title ?? 'The plan'}
        action={
          <Button type="button" size="sm" variant="ghost" onClick={onEditPlan}>
            <Pencil /> {plan ? 'Edit plan' : 'Write the plan'}
          </Button>
        }
      >
        {plan ? (
          <div className="space-y-1 text-xs">
            <p className="text-muted-foreground">
              {plan.mode === 'plan'
                ? 'Plan mode, no context budget'
                : 'Sized to the context budget'}
              {plan.reviewEachTask ? ', pauses after each task' : ''}
            </p>
            {goal ? <p>{goal}</p> : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No PLAN.md yet. Write one to keep the goal, the definition of done and what is out of
            scope with the tasks.
          </p>
        )}
        <div className="mt-3">
          <ProgressBar progress={overall} label="Done overall" />
        </div>
      </Panel>

      <Panel title="Milestones">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tasks yet.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.milestone?.id ?? 'none'} className="space-y-1">
                <p className="flex items-center gap-1.5 text-xs">
                  {row.milestone ? (
                    <>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {row.milestone.id}
                      </span>
                      {row.milestone.title}
                      {row.milestone.target ? (
                        <span className="text-muted-foreground">by {row.milestone.target}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">No milestone</span>
                  )}
                </p>
                <ProgressBar
                  progress={row.progress}
                  label={row.milestone ? `${row.milestone.id} done` : 'No milestone done'}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Needs you">
          {blocked.length + testing.length + overdue.length + openQuestions.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing is waiting on you.</p>
          ) : (
            <ul className="space-y-0.5">
              {[...blocked, ...testing].map(taskLink)}
              {overdue
                .filter((task) => !blocked.includes(task) && !testing.includes(task))
                .map(taskLink)}
              {openQuestions.map((item) => (
                <li key={item.id} className="px-1.5 py-1 text-xs">
                  <span className="font-mono text-[11px] text-muted-foreground">{item.id}</span>{' '}
                  {item.title}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Workarounds and risks">
          {ready.length + risks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {revisits.isFetching
                ? 'Checking the workarounds…'
                : 'No workaround can go yet, and no risk is open.'}
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {ready.map((entry) => (
                <li key={entry.id}>
                  <span className="font-mono text-[11px] text-muted-foreground">{entry.id}</span>{' '}
                  {entry.title}: <span className="text-success">{REVISIT_WORDS[entry.state]}</span>.{' '}
                  {entry.reason}
                </li>
              ))}
              {risks.map((item) => (
                <li key={item.id}>
                  <span className="font-mono text-[11px] text-muted-foreground">{item.id}</span>{' '}
                  {item.title}
                  {item.impact ? ` (impact ${item.impact})` : ''}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Recently done">
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing finished yet.</p>
        ) : (
          <ul className="space-y-0.5">{recent.map(taskLink)}</ul>
        )}
      </Panel>
    </div>
  );
}

const COLUMNS: { key: TaskSortKey; label: string }[] = [
  { key: 'id', label: 'Id' },
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'size', label: 'Size' },
  { key: 'milestone', label: 'Milestone' },
  { key: 'due', label: 'Due' },
];

/** Every task in a table you can sort and filter. */
export function RelayTaskList({
  board,
  pack,
  onSelectTask,
}: {
  board: RelayBoard;
  pack: RelayPlanPack | undefined;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const [sort, setSort] = useState<{ key: TaskSortKey; descending: boolean }>({
    key: 'id',
    descending: false,
  });
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);
  const today = todayString();
  const labels = useMemo(
    () => [...new Set(board.tasks.flatMap((task) => task.labels))].sort(),
    [board.tasks],
  );
  const rows = sortTasks(filterTasks(board.tasks, filter), sort.key, sort.descending);
  const select = 'h-7 rounded-md border border-input bg-background px-1.5 text-xs';

  return (
    <div aria-label="Task list" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search tasks"
          placeholder="Search by id or title"
          value={filter.text}
          onChange={(event) => setFilter({ ...filter, text: event.target.value })}
          className="h-7 w-56 text-xs"
        />
        <select
          aria-label="Filter by status"
          className={select}
          value={filter.status ?? ''}
          onChange={(event) =>
            setFilter({ ...filter, status: (event.target.value || null) as TaskFilter['status'] })
          }
        >
          <option value="">Any status</option>
          {(['todo', 'in-progress', 'testing', 'done', 'blocked'] as const).map((status) => (
            <option key={status} value={status}>
              {columnSpec(status).label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by priority"
          className={select}
          value={filter.priority ?? ''}
          onChange={(event) =>
            setFilter({
              ...filter,
              priority: (event.target.value || null) as TaskFilter['priority'],
            })
          }
        >
          <option value="">Any priority</option>
          {Object.entries(PRIORITY_WORDS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by milestone"
          className={select}
          value={filter.milestone ?? ''}
          onChange={(event) => setFilter({ ...filter, milestone: event.target.value || null })}
        >
          <option value="">Any milestone</option>
          {(pack?.items.milestone ?? []).map((milestone) => (
            <option key={milestone.id} value={milestone.id}>
              {milestone.id} {milestone.title}
            </option>
          ))}
        </select>
        {labels.length > 0 ? (
          <select
            aria-label="Filter by label"
            className={select}
            value={filter.label ?? ''}
            onChange={(event) => setFilter({ ...filter, label: event.target.value || null })}
          >
            <option value="">Any label</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {rows.length} of {board.tasks.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl ring-1 ring-foreground/[0.07] ring-inset">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-popover/95 backdrop-blur">
            <tr>
              {COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                    className="px-2 py-1.5 text-left font-medium text-muted-foreground"
                  >
                    <button
                      type="button"
                      className="cursor-pointer hover:text-foreground"
                      onClick={() =>
                        setSort({
                          key: column.key,
                          descending: active ? !sort.descending : false,
                        })
                      }
                    >
                      {column.label}
                      {active ? (sort.descending ? ' ↓' : ' ↑') : ''}
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                Labels
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((task) => (
              <tr
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                className="cursor-pointer border-t border-border/50 hover:bg-foreground/[0.04]"
              >
                <td className="px-2 py-1.5 font-mono text-[11px]">{task.id}</td>
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    className="cursor-pointer text-left"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectTask(task.id);
                    }}
                  >
                    {task.title}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <StatusChip status={task.status} />
                </td>
                <td className="px-2 py-1.5">
                  {task.priority ? PRIORITY_WORDS[task.priority] : ''}
                </td>
                <td className="px-2 py-1.5">{task.size ? SIZE_WORDS[task.size] : ''}</td>
                <td className="px-2 py-1.5 font-mono text-[11px]">{task.milestone ?? ''}</td>
                <td
                  className={cn(
                    'px-2 py-1.5 tabular-nums',
                    task.status !== 'done' && isOverdue(task.due, today) && 'text-destructive',
                  )}
                >
                  {task.due ?? ''}
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">{task.labels.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">No task matches.</p>
        ) : null}
      </div>
    </div>
  );
}

/** Milestones in order, with their dates, their tasks and how far along they are. */
export function RelayRoadmap({
  board,
  pack,
  onSelectTask,
}: {
  board: RelayBoard;
  pack: RelayPlanPack | undefined;
  onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState<RelayItem | null | 'new'>(null);
  const rows = milestoneRows(board.tasks, pack?.items.milestone ?? []);
  const today = todayString();
  return (
    <div aria-label="Roadmap" className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="soft" onClick={() => setEditing('new')}>
          <Plus /> New milestone
        </Button>
      </div>
      <ol className="relative space-y-3 border-l border-border/80 pl-4">
        {rows.map((row) => {
          const late =
            row.milestone?.status !== 'done' && isOverdue(row.milestone?.target ?? null, today);
          return (
            <li key={row.milestone?.id ?? 'none'} className="relative">
              <span
                aria-hidden
                className={cn(
                  'absolute top-1.5 -left-[21px] h-2.5 w-2.5 rounded-full border-2 border-background',
                  row.progress.percent === 100 ? 'bg-success' : 'bg-primary',
                )}
              />
              <Panel
                title={
                  row.milestone ? `${row.milestone.id} ${row.milestone.title}` : 'No milestone'
                }
                action={
                  row.milestone ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${row.milestone.id}`}
                      onClick={() => setEditing(row.milestone)}
                    >
                      <Pencil />
                    </Button>
                  ) : null
                }
              >
                <p
                  className={cn(
                    'mb-2 text-[11px] text-muted-foreground',
                    late && 'text-destructive',
                  )}
                >
                  {row.milestone
                    ? `${row.milestone.status}${row.milestone.target ? `, target ${row.milestone.target}` : ''}${late ? ', late' : ''}`
                    : 'Tasks that belong to no milestone'}
                </p>
                <ProgressBar
                  progress={row.progress}
                  label={row.milestone ? `${row.milestone.id} progress` : 'No milestone progress'}
                />
                <ul className="mt-2 flex flex-wrap gap-1">
                  {row.tasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        onClick={() => onSelectTask(task.id)}
                        className="cursor-pointer rounded-md bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[10.5px] hover:bg-foreground/[0.1]"
                        style={{ color: `hsl(${columnSpec(task.status).tone})` }}
                      >
                        {task.id}
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            </li>
          );
        })}
      </ol>
      <RelayItemDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        projectId={board.projectId}
        kind="milestone"
        item={editing === 'new' ? null : editing}
      />
    </div>
  );
}

const RECORD_KINDS: RelayItemKind[] = ['decision', 'workaround', 'risk', 'question', 'milestone'];

/** Decisions, workarounds, risks, questions and milestones, with detail and edit. */
export function RelayRecords({
  board,
  pack,
}: {
  board: RelayBoard;
  pack: RelayPlanPack | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<RelayItemKind>('decision');
  const [editing, setEditing] = useState<RelayItem | null | 'new'>(null);
  const revisits = useRevisits(board.projectId, kind === 'workaround');
  const items = pack?.items[kind] ?? [];
  const spec = RELAY_ITEM_SPECS[kind];
  const revisitOf = (id: string) => revisits.data?.find((entry) => entry.id === id);

  async function fixWithAi(item: RelayItem): Promise<void> {
    try {
      const taskId = await window.runova.relay.fixWorkaround(board.projectId, item.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(board.projectId) });
      toast.success(`Added ${taskId} to take out ${item.id}`, {
        description: 'Run it from the board when you are ready.',
      });
    } catch (error) {
      toast.error('Could not add the task', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div aria-label="Records" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Kind of record" className="flex flex-wrap gap-1">
          {RECORD_KINDS.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={kind === option}
              onClick={() => setKind(option)}
              className={cn(
                'cursor-pointer rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors',
                kind === option
                  ? 'bg-foreground/10 text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.05]',
              )}
            >
              {RELAY_ITEM_SPECS[option].plural} ({pack?.items[option].length ?? 0})
            </button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="soft"
          className="ml-auto"
          onClick={() => setEditing('new')}
        >
          <Plus /> New {spec.label.toLowerCase()}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted-foreground">
            No {spec.plural.toLowerCase()} yet. Sessions write them as they work, and you can add
            your own.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => {
              const revisit = kind === 'workaround' ? revisitOf(item.id) : undefined;
              const canGo = revisit && (revisit.state === 'ready' || revisit.state === 'due');
              const lead = bodySection(item.body, spec.sections[0]?.heading ?? '');
              return (
                <li
                  key={item.id}
                  aria-label={`${item.id} ${item.title}`}
                  className="rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-foreground/[0.07] ring-inset"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {item.id}
                        </span>
                        {item.title}
                        <span className="rounded-full bg-foreground/[0.07] px-1.5 py-px text-[10px] font-normal">
                          {item.status}
                        </span>
                        {revisit && item.status === 'open' ? (
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-px text-[10px] font-normal',
                              canGo ? 'bg-success/15 text-success' : 'bg-foreground/[0.07]',
                            )}
                          >
                            {REVISIT_WORDS[revisit.state]}
                          </span>
                        ) : null}
                      </p>
                      {revisit && item.status === 'open' ? (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{revisit.reason}</p>
                      ) : null}
                      {lead ? <p className="mt-1 line-clamp-3 text-xs">{lead}</p> : null}
                    </div>
                    {canGo && item.status === 'open' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="tint"
                        onClick={() => void fixWithAi(item)}
                      >
                        <Wand2 /> Fix with AI
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${item.id}`}
                      onClick={() => setEditing(item)}
                    >
                      <Pencil />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <RelayItemDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        projectId={board.projectId}
        kind={kind}
        item={editing === 'new' ? null : editing}
      />
    </div>
  );
}
