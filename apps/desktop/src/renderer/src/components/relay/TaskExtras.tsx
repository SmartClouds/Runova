import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { queryKeys } from '@/lib/queryKeys';
import { acceptanceItems } from './planView';

/** A task's acceptance criteria as boxes a person can tick (E122), written straight to the file. */
export function AcceptanceChecklist({
  projectId,
  taskId,
  body,
}: {
  projectId: string;
  taskId: string;
  body: string;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const items = acceptanceItems(body);
  if (items.length === 0) return null;

  async function toggle(index: number, checked: boolean): Promise<void> {
    try {
      await window.runova.relay.toggleAcceptance(projectId, taskId, index, checked);
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayTask(projectId, taskId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
    } catch (error) {
      toast.error('Could not change the criterion', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <section aria-label="Acceptance criteria">
      <h3 className="mb-1 text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
        Acceptance criteria
      </h3>
      <ul className="space-y-1">
        {items.map((item, index) => {
          const id = `acceptance-${taskId}-${index}`;
          return (
            <li key={index} className="flex items-start gap-2">
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={item.checked}
                onCheckedChange={(checked) => void toggle(index, checked === true)}
              />
              <label htmlFor={id} className="cursor-pointer text-[12px] leading-snug">
                {item.text}
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The sessions Runova wrote into the task's journal, newest first. */
export function TaskJournal({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: queryKeys.relayJournal(projectId, taskId),
    queryFn: () => window.runova.relay.journal(projectId, taskId),
  });
  const entries = query.data ?? [];
  if (entries.length === 0) return null;
  return (
    <section aria-label="Journal">
      <h3 className="mb-1 text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
        Journal
      </h3>
      <ol className="space-y-2">
        {[...entries].reverse().map((entry) => (
          <li key={entry.heading} className="text-[11.5px]">
            <p className="font-medium">{entry.heading}</p>
            <p className="text-muted-foreground">{entry.lines.join(' · ')}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
