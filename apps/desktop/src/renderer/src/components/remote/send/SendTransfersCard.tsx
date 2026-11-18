import { FINISHED_PHASES } from '@shared/fileSend';
import { useEffect, useState } from 'react';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useFileSend } from '@/stores/fileSendStore';
import { REMOTE_CARD } from '../remoteCard';
import { BatchRow } from './BatchRow';

/**
 * Every send out and in (E112), newest first, in the Remote page's rail beside whichever view is
 * open. A countdown ticks only while something waits on an answer.
 */
export function SendTransfersCard({ className }: { className?: string }): React.JSX.Element | null {
  const { batches } = useFileSend();
  const waiting = batches.some((b) => b.phase === 'waiting' || b.phase === 'asking');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  if (batches.length === 0) return null;
  const finished = batches.some((b) => FINISHED_PHASES.includes(b.phase));

  return (
    <section
      aria-label="Sent and received"
      className={cn(REMOTE_CARD, 'flex min-h-0 flex-col', className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 px-4">
        <h2 className={SECTION_HEADING}>Sent and received</h2>
        <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-muted-foreground">
          {batches.length}
        </span>
        {finished ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            shape="pill"
            className="ml-auto"
            onClick={() => void window.runova.fileSend.clearFinished()}
          >
            Clear finished
          </Button>
        ) : null}
      </div>
      <ul className="settings-rows rail-scroll min-h-0 overflow-y-auto">
        {batches.map((batch) => (
          <BatchRow key={batch.id} batch={batch} now={now} />
        ))}
      </ul>
    </section>
  );
}
