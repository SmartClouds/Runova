import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import { Spinner, Undo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAgentChoices } from '@/components/workspace/useAgentChoices';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Redo with another agent (E121). The task's handoff and journal are archived as the attempt that
 * ends, and it runs again from its spec with the CLI picked here. Keeping what was learned points
 * the new attempt at the archive; without it, the agent starts fresh.
 */
export function RedoDialog({
  open,
  onOpenChange,
  projectId,
  taskIds,
  currentAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The tasks to redo, or `all` for every task that is not done. */
  taskIds: string[] | 'all';
  currentAgent: string | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const agents = useAgentChoices(null);
  const [agent, setAgent] = useState(currentAgent ?? '');
  const [keepLearnings, setKeepLearnings] = useState(true);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setAgent(currentAgent ?? '');
  }, [open, currentAgent]);

  const options: ComboboxOption[] = agents.installed.map((choice) => ({
    value: choice.cli.id,
    label: choice.cli.name,
    icon: <CliLogo cliId={choice.cli.id} className="h-3.5 w-3.5" />,
  }));
  const what = taskIds === 'all' ? 'every unfinished task' : taskIds.join(', ');

  async function redo(): Promise<void> {
    setBusy(true);
    try {
      const result = await window.runova.relay.redo({
        projectId,
        taskIds,
        agent: agent || null,
        keepLearnings,
        start,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
      for (const warning of result.warnings) toast.warning(warning);
      if (result.error) {
        toast.error('The tasks were reset, but the relay did not start', {
          description: result.error,
        });
      } else if (result.redone.length > 0) {
        toast.success(
          result.started
            ? `Running ${result.redone.join(', ')} again`
            : `${result.redone.join(', ')} will start over`,
        );
      }
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not redo the tasks', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Redo with another agent</DialogTitle>
          <DialogDescription>
            Starts {what} over from the spec. The handoff and journal so far are kept in the
            archive, so nothing is lost.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Agent</Label>
            <Combobox
              ariaLabel="Agent"
              className="h-8 text-xs"
              value={agent}
              onChange={setAgent}
              placeholder="Keep each task's own"
              searchPlaceholder="Search CLIs…"
              emptyText="No AI CLI is installed."
              options={options}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium">Learn from the earlier attempt</p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                The new attempt reads what the last one decided, worked around and ruled out. Turn
                it off for a clean second opinion.
              </p>
            </div>
            <Switch
              aria-label="Learn from the earlier attempt"
              checked={keepLearnings}
              onCheckedChange={setKeepLearnings}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium">Start now</p>
            <Switch aria-label="Start now" checked={start} onCheckedChange={setStart} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void redo()}>
            {busy ? <Spinner className="animate-spin" /> : <Undo />} Redo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
