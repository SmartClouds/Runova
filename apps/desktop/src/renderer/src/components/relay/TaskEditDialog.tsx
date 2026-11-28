import {
  RELAY_PRIORITIES,
  RELAY_SIZES,
  type RelayItem,
  type RelayPriority,
  type RelaySize,
} from '@runova/core';
import type { RelayTaskCard } from '@shared/relayTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/icons';
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
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { PRIORITY_WORDS, SIZE_WORDS } from './planView';

const NONE = '';

interface Form {
  title: string;
  priority: RelayPriority | typeof NONE;
  size: RelaySize | typeof NONE;
  milestone: string;
  labels: string;
  agent: string;
  due: string;
  depends: string;
  body: string;
}

function formFor(task: RelayTaskCard | null, body: string): Form {
  return {
    title: task?.title ?? '',
    priority: task?.priority ?? NONE,
    size: task?.size ?? NONE,
    milestone: task?.milestone ?? NONE,
    labels: task?.labels.join(', ') ?? '',
    agent: task?.agent ?? '',
    due: task?.due ?? '',
    depends: task?.depends.join(', ') ?? '',
    body,
  };
}

const NEW_BODY =
  '## Goal\n\n\n\n## Scope\n\n\n\n## Acceptance criteria\n\n- [ ] \n\n## Test plan\n\n';

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Adds a task, or edits one: its planning fields and its spec as Markdown (E122). Only what changed
 * is written, and Runova keeps the rest of the file as it was.
 */
export function TaskEditDialog({
  open,
  onOpenChange,
  projectId,
  task,
  body,
  milestones,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The task to edit, or null to add one. */
  task: RelayTaskCard | null;
  /** The task's body as it is now. */
  body: string;
  milestones: readonly RelayItem[];
  onCreated?: (taskId: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form>(() => formFor(task, task ? body : NEW_BODY));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(formFor(task, task ? body : NEW_BODY));
  }, [open, task, body]);

  const field =
    <K extends keyof Form>(key: K) =>
    (value: Form[K]) =>
      setForm((current) => ({ ...current, [key]: value }));

  async function save(): Promise<void> {
    if (!form.title.trim()) return;
    setSaving(true);
    const common = {
      priority: form.priority || null,
      size: form.size || null,
      milestone: form.milestone || null,
      labels: splitList(form.labels),
      agent: form.agent.trim() || null,
      due: form.due || null,
      depends: splitList(form.depends).map((id) => id.toUpperCase()),
    };
    try {
      if (task) {
        await window.runova.relay.updateTask(projectId, task.id, {
          title: form.title.trim(),
          ...common,
        });
        if (form.body.trim() !== body.trim()) {
          await window.runova.relay.saveTaskBody(projectId, task.id, form.body);
        }
      } else {
        const id = await window.runova.relay.createTask(projectId, {
          title: form.title.trim(),
          ...common,
        });
        if (form.body.trim()) await window.runova.relay.saveTaskBody(projectId, id, form.body);
        onCreated?.(id);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
      if (task) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.relayTask(projectId, task.id) });
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(task ? 'Could not save the task' : 'Could not add the task', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }

  const select = 'h-8 w-full rounded-md border border-input bg-background px-2 text-xs';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>{task ? `Edit ${task.id}` : 'New task'}</DialogTitle>
          <DialogDescription>
            {task
              ? 'Changes go into the task file. Runova keeps everything else in it as it was.'
              : 'Runova gives it the next free id and adds it to the board as To do.'}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1">
            <Label htmlFor="task-title" className="text-xs text-muted-foreground">
              Title
            </Label>
            <Input
              id="task-title"
              value={form.title}
              onChange={(event) => field('title')(event.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="task-priority" className="text-xs text-muted-foreground">
                Priority
              </Label>
              <select
                id="task-priority"
                className={select}
                value={form.priority}
                onChange={(event) => field('priority')(event.target.value as Form['priority'])}
              >
                <option value={NONE}>None</option>
                {RELAY_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {PRIORITY_WORDS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="task-size" className="text-xs text-muted-foreground">
                Size
              </Label>
              <select
                id="task-size"
                className={select}
                value={form.size}
                onChange={(event) => field('size')(event.target.value as Form['size'])}
              >
                <option value={NONE}>None</option>
                {RELAY_SIZES.map((value) => (
                  <option key={value} value={value}>
                    {SIZE_WORDS[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="task-milestone" className="text-xs text-muted-foreground">
                Milestone
              </Label>
              <select
                id="task-milestone"
                className={select}
                value={form.milestone}
                onChange={(event) => field('milestone')(event.target.value)}
              >
                <option value={NONE}>None</option>
                {milestones.map((milestone) => (
                  <option key={milestone.id} value={milestone.id}>
                    {milestone.id} {milestone.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="task-due" className="text-xs text-muted-foreground">
                Due
              </Label>
              <Input
                id="task-due"
                type="date"
                value={form.due}
                onChange={(event) => field('due')(event.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="task-labels" className="text-xs text-muted-foreground">
                Labels
              </Label>
              <Input
                id="task-labels"
                placeholder="api, ui"
                value={form.labels}
                onChange={(event) => field('labels')(event.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="task-depends" className="text-xs text-muted-foreground">
                Depends on
              </Label>
              <Input
                id="task-depends"
                placeholder="T001, T002"
                value={form.depends}
                onChange={(event) => field('depends')(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="task-agent" className="text-xs text-muted-foreground">
                Agent
              </Label>
              <Input
                id="task-agent"
                placeholder="The relay's choice"
                value={form.agent}
                onChange={(event) => field('agent')(event.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="task-body" className="text-xs text-muted-foreground">
              Spec (Markdown)
            </Label>
            <Textarea
              id="task-body"
              value={form.body}
              onChange={(event) => field('body')(event.target.value)}
              className="min-h-64 font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !form.title.trim()}
            onClick={() => void save()}
          >
            {saving ? <Spinner className="animate-spin" /> : null}
            {task ? 'Save' : 'Add task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
