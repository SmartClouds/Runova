import type { CloneJob } from '@shared/apiTypes';
import { useNavigate } from 'react-router-dom';
import { CloneProgressCard } from '@/components/clone/CloneProgressCard';
import { CircleCheck, CircleX } from '@/components/icons';
import { cloneHeadline } from '@/lib/cloneJobText';
import { useCloneJobs } from '@/stores/cloneJobsStore';
import { focusPanel, PanelTitle, PopSegment } from './statusBarKit';

/**
 * Background clones in the status bar, so a clone started on the Projects page can be followed
 * from any page. A running clone shows a small ring and its percent; a failed one stays until it
 * is retried or dismissed; a finished one shows as ready for the few seconds main keeps it. The
 * panel holds the full card of each, with Stop, Try again and a way into the project.
 */

/** A 12px ring that fills with the percent, drawn in the bar's text color. */
function ProgressRing({ percent }: { percent: number }): React.JSX.Element {
  const radius = 4.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 -rotate-90 text-primary">
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={2}
      />
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.max(0, Math.min(100, percent)) / 100)}
        className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
      />
    </svg>
  );
}

interface SegmentView {
  label: string;
  icon: React.ReactNode;
  text: string;
  percent: number | null;
  className?: string;
}

function segmentView(jobs: CloneJob[]): SegmentView | null {
  const running = jobs.filter((job) => job.status === 'running');
  const failed = jobs.filter((job) => job.status === 'failed');
  const done = jobs.filter((job) => job.status === 'succeeded');
  const one = (list: CloneJob[]) => (list.length === 1 ? list[0] : undefined);

  if (running.length > 0) {
    const percent = Math.round(running.reduce((sum, job) => sum + job.percent, 0) / running.length);
    const single = one(running);
    return {
      label: single ? cloneHeadline(single) : `Cloning ${running.length} projects`,
      icon: <ProgressRing percent={percent} />,
      text: single ? cloneHeadline(single) : `${running.length} clones`,
      percent,
    };
  }
  if (failed.length > 0) {
    const single = one(failed);
    return {
      label: single ? cloneHeadline(single) : `Couldn't clone ${failed.length} projects`,
      icon: <CircleX className="h-3 w-3" />,
      text: single ? 'Clone failed' : `${failed.length} clones failed`,
      percent: null,
      className: 'text-destructive hover:text-destructive',
    };
  }
  if (done.length > 0) {
    const single = one(done);
    const text = single ? cloneHeadline(single) : `${done.length} projects ready`;
    return {
      label: text,
      icon: <CircleCheck className="h-3 w-3 text-success" />,
      text,
      percent: null,
    };
  }
  return null;
}

export function CloneJobsSegment(): React.JSX.Element | null {
  const navigate = useNavigate();
  const jobs = useCloneJobs().filter((job) => job.status !== 'cancelled');
  const view = segmentView(jobs);
  if (!view) return null;

  return (
    <PopSegment
      label={view.label}
      tooltip={view.percent !== null ? `${view.label}, ${view.percent}%` : undefined}
      width="w-[22rem]"
      onOpenAutoFocus={focusPanel}
      className={view.className}
      panel={
        <>
          <PanelTitle
            title="Clones"
            detail={view.percent !== null ? `${view.percent}% overall` : undefined}
          />
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {jobs.map((job) => (
              <CloneProgressCard
                key={job.id}
                job={job}
                variant="full"
                onOpen={() => navigate(`/projects/${job.projectId}?tab=git`)}
              />
            ))}
          </div>
        </>
      }
    >
      {view.icon}
      <span className="max-w-[12rem] truncate">{view.text}</span>
      {view.percent !== null ? <span className="tabular-nums">{`${view.percent}%`}</span> : null}
    </PopSegment>
  );
}
