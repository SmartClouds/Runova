import type { StatusBarFeed } from '@shared/apiTypes';
import { useEffect } from 'react';
import { type RunRow, useRunRows } from '@/hooks/useRunRows';
import { type PlanJob, useRelayPlanJobsStore } from '@/stores/relayPlanJobsStore';

const PUBLISH_DELAY_MS = 250;

/** What the status bar's Run and Relay plan items show, for anything outside this window. */
export function statusFeedOf(
  rows: readonly RunRow[],
  jobs: Record<string, PlanJob | undefined>,
): StatusBarFeed {
  return {
    runs: rows.map((row) => ({
      id: row.session.id,
      title: row.session.title,
      state: row.state,
      // Until there is a second reading the CPU figure means nothing, so it isn't passed on.
      cpuPercent: row.status && row.cpuReady ? row.status.cpuPercent : null,
      memBytes: row.status?.memBytes ?? null,
      urls: row.urls,
      device: row.device?.name ?? null,
    })),
    plans: Object.values(jobs)
      .filter((job): job is PlanJob => Boolean(job))
      .map((job) => ({
        key: job.key,
        kind: job.kind,
        projectName: job.projectName,
        status: job.status,
        startedAt: job.startedAt,
        error: job.error,
      })),
  };
}

/** Tells main what the bar shows, only when that changes. */
export function StatusFeedPublisher(): null {
  const rows = useRunRows();
  const jobs = useRelayPlanJobsStore((s) => s.jobs);
  const signature = JSON.stringify(statusFeedOf(rows, jobs));

  useEffect(() => {
    const timer = setTimeout(() => {
      void window.runova.agents.publishStatusBar(JSON.parse(signature) as StatusBarFeed);
    }, PUBLISH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [signature]);

  return null;
}
