import type { CleanResult } from '@runova/core';
import { RefreshCw, X } from '@/components/icons';
import { Notice, type NoticeTone } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';

/**
 * What a clean-up did, said plainly and honestly. A run that freed some space and could not
 * remove the rest is not shown as a success: it says how much went, how many things stayed, and
 * why each one stayed, because the person decides what to do next from that.
 */

export interface ResultNoticeProps {
  /** One result for each cache that was cleaned in the action, in order. */
  results: readonly CleanResult[];
  error: string | null;
  onDismiss: () => void;
  onScan: () => void;
}

/** More failures than this are counted rather than listed, so the notice stays short. */
const LISTED = 5;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function ResultNotice({
  results,
  error,
  onDismiss,
  onScan,
}: ResultNoticeProps): React.JSX.Element | null {
  const dismiss = (
    <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
      <X />
    </Button>
  );

  if (error) {
    return (
      <Notice
        role="alert"
        tone="destructive"
        className="items-center"
        action={
          <>
            <Button size="sm" variant="soft" onClick={onScan}>
              <RefreshCw />
              Scan again
            </Button>
            {dismiss}
          </>
        }
      >
        <span className="whitespace-pre-wrap break-words">{error}</span>
      </Notice>
    );
  }
  if (results.length === 0) return null;

  const freed = results.reduce((sum, one) => sum + one.freedBytes, 0);
  const removed = results.reduce((sum, one) => sum + one.removed, 0);
  const cancelled = results.some((one) => one.cancelled);
  const failures = results.flatMap((one) =>
    one.failed.map((failure) => ({ cache: one.provider.label, ...failure })),
  );
  const skipped = results.flatMap((one) => one.skipped);

  let tone: NoticeTone;
  let headline: string;
  if (failures.length > 0 && removed === 0) {
    tone = 'destructive';
    headline = 'Nothing could be removed.';
  } else if (failures.length > 0) {
    tone = 'warning';
    headline = `Freed ${formatBytes(freed)}. ${plural(failures.length, 'item')} could not be removed.`;
  } else if (cancelled) {
    tone = 'neutral';
    headline = `Stopped. Freed ${formatBytes(freed)} before it stopped.`;
  } else if (removed === 0 && freed === 0) {
    tone = 'neutral';
    headline = 'There was nothing to remove.';
  } else {
    tone = 'success';
    const from =
      results.length === 1
        ? (results[0]?.provider.label ?? 'the cache')
        : plural(results.length, 'cache');
    headline = `Freed ${formatBytes(freed)} from ${from}.`;
  }

  return (
    <Notice role={failures.length > 0 ? 'alert' : 'status'} tone={tone} action={dismiss}>
      <p className="font-medium">{headline}</p>
      {failures.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
          {failures.slice(0, LISTED).map((failure) => (
            <li key={`${failure.cache}/${failure.itemId}/${failure.label}`}>
              {failure.cache}: {failure.label}, {failure.reason}
            </li>
          ))}
          {failures.length > LISTED && <li>and {failures.length - LISTED} more</li>}
        </ul>
      )}
      {skipped.length > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Left alone: {skipped.map((skip) => `${skip.label}, ${skip.reason}`).join('; ')}
        </p>
      )}
    </Notice>
  );
}
