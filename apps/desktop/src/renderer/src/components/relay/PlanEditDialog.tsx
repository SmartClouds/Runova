import { bodySection, type RelayPlan } from '@runova/core';
import type { RelayPlanModeChoice } from '@shared/relayTypes';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { PlanModePicker } from './PlanModePicker';

/**
 * Writes PLAN.md (E122): the plan's title, goal, definition of done and what is out of scope, and
 * the run options it turns on for everyone who runs it.
 */
export function PlanEditDialog({
  open,
  onOpenChange,
  projectId,
  plan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  plan: RelayPlan | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<RelayPlanModeChoice>('fit');
  const [goal, setGoal] = useState('');
  const [done, setDone] = useState('');
  const [outOfScope, setOutOfScope] = useState('');
  const [reviewEachTask, setReviewEachTask] = useState(false);
  const [keepRolling, setKeepRolling] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(plan?.title ?? '');
    setMode(plan?.mode ?? 'fit');
    setGoal(plan ? bodySection(plan.body, 'Goal') : '');
    setDone((plan?.definitionOfDone ?? []).join('\n'));
    setOutOfScope(plan ? bodySection(plan.body, 'Out of scope') : '');
    setReviewEachTask(plan?.reviewEachTask ?? false);
    setKeepRolling(plan?.keepRolling ?? false);
  }, [open, plan]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await window.runova.relay.savePlan(projectId, {
        title: title.trim() || 'Plan',
        mode,
        goal,
        outOfScope,
        definitionOfDone: done
          .split('\n')
          .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
          .filter(Boolean),
        reviewEachTask,
        keepRolling: mode === 'plan' || keepRolling,
        runPastBudget: mode === 'plan' ? true : (plan?.runPastBudget ?? false),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayPlanPack(projectId) });
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not save the plan', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>{plan ? 'Edit the plan' : 'Write the plan'}</DialogTitle>
          <DialogDescription>
            Saved as PLAN.md next to the tasks. Every session reads it first.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1">
            <Label htmlFor="plan-title" className="text-xs text-muted-foreground">
              Title
            </Label>
            <Input
              id="plan-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <PlanModePicker value={mode} onChange={setMode} />
          <div className="space-y-1">
            <Label htmlFor="plan-goal" className="text-xs text-muted-foreground">
              Goal
            </Label>
            <Textarea
              id="plan-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              className="min-h-16 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-done" className="text-xs text-muted-foreground">
              Definition of done (one check per line)
            </Label>
            <Textarea
              id="plan-done"
              value={done}
              onChange={(event) => setDone(event.target.value)}
              className="min-h-16 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-out" className="text-xs text-muted-foreground">
              Out of scope
            </Label>
            <Textarea
              id="plan-out"
              value={outOfScope}
              onChange={(event) => setOutOfScope(event.target.value)}
              className="min-h-16 text-xs"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium">Review each task</p>
            <Switch
              aria-label="Review each task"
              checked={reviewEachTask}
              onCheckedChange={setReviewEachTask}
            />
          </div>
          {mode === 'fit' ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium">Keep handing off past the session limit</p>
              <Switch
                aria-label="Keep handing off"
                checked={keepRolling}
                onCheckedChange={setKeepRolling}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner className="animate-spin" /> : null}
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
