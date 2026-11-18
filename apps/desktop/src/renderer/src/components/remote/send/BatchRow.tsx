import {
  batchStatus,
  batchTitle,
  FINISHED_PHASES,
  type SendBatchView,
  type SendFileView,
} from '@shared/fileSend';
import { formatBytes } from '@shared/remoteProtocol';
import { useState } from 'react';
import {
  Check,
  ChevronDown,
  CircleX,
  FolderOpen,
  Inbox,
  RefreshCw,
  Send,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { fileKind, KIND_LOOK } from './fileKinds';
import { RunwayProgress, type RunwayTone } from './RunwayProgress';

const BAD: SendBatchView['phase'][] = ['declined', 'expired', 'failed', 'cancelled'];

function toneOf(batch: SendBatchView): RunwayTone {
  switch (batch.phase) {
    case 'connecting':
    case 'waiting':
    case 'asking':
      return 'waiting';
    case 'reconnecting':
      return 'paused';
    case 'done':
      return 'done';
    case 'transferring':
      return 'moving';
    default:
      return 'failed';
  }
}

/**
 * One send in a list (E112): who it is with, a line that says what it is doing in words, the
 * runway, and the one or two things that can be done with it now. Drawn small for the status bar
 * panel, without the file list.
 */
export function BatchRow({
  batch,
  now,
  compact = false,
}: {
  batch: SendBatchView;
  now: number;
  compact?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const api = window.runova.fileSend;
  const finished = FINISHED_PHASES.includes(batch.phase);
  const bad = BAD.includes(batch.phase);
  const title = batchTitle(batch);
  const Direction = batch.direction === 'out' ? Send : Inbox;

  return (
    <li className={cn('flex flex-col gap-2', compact ? 'py-2' : 'px-4 py-3')}>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            batch.phase === 'done'
              ? 'bg-success/12 text-success'
              : bad
                ? 'bg-destructive/12 text-destructive'
                : 'bg-primary/12 text-primary',
          )}
        >
          <Direction className="h-3.5 w-3.5" />
          <span className="sr-only">{batch.direction === 'out' ? 'Sent' : 'Received'}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium" {...persianTextProps(title)}>
            {title}
          </div>
          <div
            role="status"
            aria-live="polite"
            className={cn(
              // It wraps: in the narrow rail the countdown and the time left are the words that
              // matter, and they come last.
              'break-words text-xs leading-snug tabular-nums',
              bad ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {batchStatus(batch, now)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!finished ? (
            <IconAction label="Cancel" onClick={() => void api.cancel(batch.id)}>
              <X />
            </IconAction>
          ) : null}
          {finished && batch.direction === 'in' && batch.phase === 'done' ? (
            <IconAction label="Show in folder" onClick={() => void api.showInFolder(batch.id)}>
              <FolderOpen />
            </IconAction>
          ) : null}
          {finished && batch.direction === 'out' && batch.phase !== 'done' ? (
            <IconAction label="Send again" onClick={() => void api.retry(batch.id)}>
              <RefreshCw />
            </IconAction>
          ) : null}
          {finished ? (
            <IconAction label="Dismiss" onClick={() => void api.dismiss(batch.id)}>
              <X />
            </IconAction>
          ) : null}
          {!compact && batch.files.length > 0 ? (
            <IconAction
              label={open ? 'Hide files' : 'Show files'}
              onClick={() => setOpen((value) => !value)}
              expanded={open}
            >
              <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
            </IconAction>
          ) : null}
        </div>
      </div>
      {!bad || (batch.phase === 'failed' && batch.transferredBytes > 0) ? (
        <RunwayProgress
          label={title}
          value={batch.transferredBytes}
          total={batch.totalBytes}
          tone={toneOf(batch)}
          className="ml-11"
        />
      ) : null}
      {open && !compact ? (
        <ul aria-label={`Files ${title}`} className="ml-11 space-y-0.5 pt-0.5">
          {batch.files.map((file) => (
            <FileLine key={file.transferId} batch={batch} file={file} />
          ))}
          {batch.moreFiles > 0 ? (
            <li className="px-2 py-1 text-[11px] text-muted-foreground">
              {`and ${batch.moreFiles.toLocaleString('en-US')} more`}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function IconAction({
  label,
  onClick,
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        shape="pill"
        aria-label={label}
        {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
        onClick={onClick}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function FileLine({
  batch,
  file,
}: {
  batch: SendBatchView;
  file: SendFileView;
}): React.JSX.Element {
  const api = window.runova.fileSend;
  const look = KIND_LOOK[fileKind(file.path)];
  const canSkip =
    batch.direction === 'out' &&
    (file.status === 'queued' || file.status === 'active') &&
    !FINISHED_PHASES.includes(batch.phase);
  const canOpen = batch.direction === 'in' && file.status === 'done' && !!file.savedPath;
  const slash = file.path.lastIndexOf('/');
  const base = file.path.slice(slash + 1);
  const folder = slash === -1 ? '' : file.path.slice(0, slash);
  // The name leads, so it is what survives a narrow list; its folder follows, quieter.
  const name = (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className="min-w-0 max-w-[75%] shrink-0 truncate" {...persianTextProps(base)}>
        {base}
      </span>
      {folder ? (
        <span
          className="min-w-0 truncate text-[11px] text-muted-foreground/70"
          {...persianTextProps(folder)}
        >
          {folder}
        </span>
      ) : null}
    </span>
  );
  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-foreground/[0.04]">
      <look.Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      {canOpen ? (
        <button
          type="button"
          aria-label={`Open ${file.path}`}
          onClick={() => void api.openFile(batch.id, file.transferId)}
          className="flex min-w-0 flex-1 rounded text-left hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {name}
        </button>
      ) : (
        name
      )}
      <span className="shrink-0 tabular-nums text-muted-foreground">
        <FileState file={file} />
      </span>
      {canSkip ? (
        <SimpleTooltip label="Skip this file">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            shape="pill"
            aria-label={`Skip ${file.path}`}
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            onClick={() => void api.cancelFile(batch.id, file.transferId)}
          >
            <X />
          </Button>
        </SimpleTooltip>
      ) : null}
    </li>
  );
}

function FileState({ file }: { file: SendFileView }): React.JSX.Element {
  switch (file.status) {
    case 'done':
      return (
        <span className="flex items-center gap-1 text-success">
          <Check className="h-2.5 w-2.5" />
          {formatBytes(file.size)}
        </span>
      );
    case 'failed':
      return (
        <SimpleTooltip label={file.error ?? 'It did not arrive intact.'}>
          <span className="flex items-center gap-1 text-destructive">
            <CircleX className="h-2.5 w-2.5" />
            Failed
          </span>
        </SimpleTooltip>
      );
    case 'skipped':
      return <span className="line-through">Skipped</span>;
    case 'active':
      return (
        <span>{`${file.size > 0 ? Math.round((file.transferred / file.size) * 100) : 0}%`}</span>
      );
    default:
      return <span>{formatBytes(file.size)}</span>;
  }
}
