import { FINISHED_PHASES, type SendBatchView } from '@shared/fileSend';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Send, Upload } from '@/components/icons';
import { BatchRow } from '@/components/remote/send/BatchRow';
import { useFileSendStore } from '@/stores/fileSendStore';
import { focusPanel, PanelTitle, PopSegment } from './statusBarKit';

/** What the bar draws, as text, so a snapshot that changes nothing on screen renders nothing. */
interface BarView {
  out: number;
  in: number;
  percent: number | null;
  waiting: boolean;
}

function barView(batches: SendBatchView[], offers: number): BarView {
  const live = batches.filter((b) => !FINISHED_PHASES.includes(b.phase));
  const moving = live.filter((b) => b.phase !== 'asking' && b.phase !== 'waiting');
  const total = moving.reduce((sum, b) => sum + b.totalBytes, 0);
  const done = moving.reduce((sum, b) => sum + b.transferredBytes, 0);
  return {
    out: live.filter((b) => b.direction === 'out').length,
    in: live.filter((b) => b.direction === 'in').length,
    percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
    waiting: offers > 0,
  };
}

/**
 * Files on their way to or from another device, in the status bar (E112), from any page: how far
 * they are, and when an offer waits for an answer here. Hidden while nothing moves.
 */
export function FileSendSegment(): React.JSX.Element | null {
  const signature = useFileSendStore((s) =>
    JSON.stringify(barView(s.state.batches, s.state.offers.length)),
  );
  const view = useMemo(() => JSON.parse(signature) as BarView, [signature]);
  if (view.out === 0 && view.in === 0 && !view.waiting) return null;

  const verb =
    view.out > 0 && view.in > 0
      ? 'Sending and receiving files'
      : view.out > 0
        ? 'Sending files'
        : 'Receiving files';
  const label = view.waiting
    ? 'Files are waiting for your answer'
    : `${verb}${view.percent !== null ? `: ${view.percent}%` : ''}`;

  return (
    <PopSegment
      label={label}
      width="w-80"
      onOpenAutoFocus={focusPanel}
      className={view.waiting ? 'text-warning hover:text-warning' : undefined}
      panel={<Panel percent={view.percent} />}
    >
      {view.out > 0 ? <Upload className="h-2.5 w-2.5" /> : null}
      {view.in > 0 ? <Download className="h-2.5 w-2.5" /> : null}
      {view.waiting ? (
        <span>Needs your answer</span>
      ) : view.percent !== null ? (
        <span className="tabular-nums">{`${view.percent}%`}</span>
      ) : (
        <Send className="h-2.5 w-2.5" />
      )}
    </PopSegment>
  );
}

/** Mounted only while open, so its once-a-second clock costs nothing the rest of the time. */
function Panel({ percent }: { percent: number | null }): React.JSX.Element {
  const batches = useFileSendStore((s) => s.state.batches);
  const live = batches.filter((b) => !FINISHED_PHASES.includes(b.phase));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <PanelTitle
        title="Files on their way"
        detail={percent !== null ? `${percent}% done` : undefined}
      />
      <ul className="settings-rows -mx-1 px-1">
        {live.map((batch) => (
          <BatchRow key={batch.id} batch={batch} now={now} compact />
        ))}
      </ul>
      <Link
        to="/remote?tab=send"
        className="mt-2 block rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        Open Send files
      </Link>
    </>
  );
}
