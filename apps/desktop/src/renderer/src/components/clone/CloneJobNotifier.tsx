import type { CloneJob } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { cloneHeadline } from '@/lib/cloneJobText';
import { queryKeys } from '@/lib/queryKeys';
import { showLinkedToast } from '@/lib/toastHistory';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { runClone } from './runClone';

/** A failure needs reading and maybe a retry, so it stays up longer than sonner's default. */
const FAILURE_TOAST_MS = 12000;

/**
 * Tells the user how a background clone ended, wherever they are in the app by then: a toast
 * that opens the project (or tries again), kept in Recent messages too. A clone the user stopped
 * needs no word, and when a card for the job is on screen the card already says it.
 *
 * Only a job seen running and then finished counts, so the jobs main hands over on load (which
 * may have ended long ago) stay quiet.
 */
export function CloneJobNotifier(): null {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The subscription outlives renders, so it reads the latest of these through refs.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    function finished(job: CloneJob, onScreen: boolean): void {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(job.projectId) });
      if (job.status === 'cancelled' || onScreen) return;

      const route = `/projects/${job.projectId}?tab=git`;
      const openProject = () => navigateRef.current(route);
      const base = {
        title: cloneHeadline(job),
        link: { route },
        projectId: job.projectId,
        projectName: job.projectName,
      };
      if (job.status === 'succeeded') {
        showLinkedToast(
          {
            ...base,
            kind: 'success',
            description: `${job.attach ? 'Connected to' : 'Cloned'} ${job.repoLabel}.`,
          },
          openProject,
          { actionLabel: 'Open project' },
        );
        return;
      }
      showLinkedToast(
        { ...base, kind: 'error', description: job.message ?? '', tag: 'Failed' },
        () => void runClone({ projectId: job.projectId, repoUrl: job.repoUrl, attach: job.attach }),
        {
          actionLabel: 'Try again',
          secondary: { label: 'Open Git tab', onClick: openProject },
          duration: FAILURE_TOAST_MS,
        },
      );
    }

    return useCloneJobsStore.subscribe((state, previous) => {
      for (const job of state.jobs) {
        if (job.status === 'running') continue;
        const before = previous.jobs.find((one) => one.id === job.id);
        if (before?.status !== 'running') continue;
        finished(job, (state.visible[job.id] ?? 0) > 0);
      }
    });
  }, [queryClient]);

  return null;
}
