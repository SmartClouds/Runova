import type { ScheduledTask } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { runPromptInWorkspace } from '@/lib/runScheduledPrompt';

/**
 * Opens automatic scheduled prompts when main says they're due: in an agent tab of the project's
 * workspace, submitted, since nobody is there to press Enter. Main has already marked each one
 * completed before sending it, so this only has to start the CLI and refresh the lists.
 */
export function useScheduledTaskRunner(): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Kept in a ref so a new navigate function never resubscribes to the due events.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasksAll });
    };

    const run = async (task: ScheduledTask): Promise<void> => {
      const projects = await window.runova.projects.list();
      const project = projects.find((p) => p.id === task.projectId);
      if (!project) {
        toast.error('A scheduled prompt was due, but its project is gone.');
        refresh();
        return;
      }
      const started = runPromptInWorkspace(project, {
        content: task.content,
        targetAI: task.targetAI,
        cliId: task.cliId,
        model: task.model,
        effort: task.effort,
        submit: true,
      });
      if (started) {
        toast.success(`Scheduled prompt started in ${started.cliName}`, {
          description: project.name,
          action: {
            label: 'Open',
            onClick: () => navigateRef.current(`/workspace/${project.id}`),
          },
        });
      } else {
        toast.error('A scheduled prompt was due, but no CLI is set up to run it.', {
          description: project.name,
        });
      }
      refresh();
    };

    const stopDue = window.runova.scheduledTasks.onDue((task) => void run(task));
    const stopChanged = window.runova.scheduledTasks.onChanged(refresh);
    return () => {
      stopDue();
      stopChanged();
    };
  }, [queryClient]);
}
