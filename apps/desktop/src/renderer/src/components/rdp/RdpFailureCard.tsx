import { toast } from 'sonner';
import { Copy, RefreshCw, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import type { RdpFailure } from '@/lib/rdp/failure';
import { cn } from '@/lib/utils';

/** What goes on the clipboard for a bug report: the three plain parts and the technical reason. */
export function failureReport(failure: RdpFailure): string {
  return [failure.title, failure.message, failure.detail && `Technical details: ${failure.detail}`]
    .filter(Boolean)
    .join('\n');
}

/**
 * The technical reason for a failure, folded away. It is for support and bug reports, so it has
 * a copy button, and it only ever holds text without source locations (see `cleanTlsDetail`).
 */
export function RdpTechnicalDetails({
  failure,
}: {
  failure: RdpFailure;
}): React.JSX.Element | null {
  if (!failure.detail) return null;
  return (
    <details className="group w-full text-left">
      <summary className="cursor-pointer select-none rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Technical details
      </summary>
      <div className="mt-2 flex items-start gap-2 rounded-lg bg-foreground/[0.05] p-2">
        <p className="min-w-0 flex-1 select-text break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
          {failure.detail}
        </p>
        <SimpleTooltip label="Copy for a bug report">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Copy technical details"
            onClick={() =>
              void navigator.clipboard.writeText(failureReport(failure)).then(
                () => toast.success('Copied'),
                () => toast.error("Couldn't copy"),
              )
            }
          >
            <Copy />
          </Button>
        </SimpleTooltip>
      </div>
    </details>
  );
}

/** What you can try, as a short list under the sentence. */
function Hints({ hints }: { hints: string[] }): React.JSX.Element | null {
  if (hints.length === 0) return null;
  return (
    <div className="w-full rounded-lg bg-foreground/[0.04] px-4 py-3 text-left">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        What you can try
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
        {hints.map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
    </div>
  );
}

/** The words of a failure: what happened, what to try, and the folded technical reason. */
export function RdpFailureBody({
  failure,
  align = 'center',
}: {
  failure: RdpFailure;
  align?: 'center' | 'start';
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex w-full flex-col gap-3',
        align === 'center' ? 'items-center text-center' : 'items-start text-left',
      )}
    >
      <div className="space-y-1.5">
        <p className="text-base font-semibold leading-snug">{failure.title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{failure.message}</p>
      </div>
      <Hints hints={failure.hints} />
      <RdpTechnicalDetails failure={failure} />
    </div>
  );
}

/**
 * The screen a session window shows when it could not connect. A changed certificate, or one not
 * trusted yet on a first connect, leads with "Review certificate", since reconnecting alone would
 * only fail the same way.
 */
export function RdpFailureCard({
  failure,
  onClose,
  onReconnect,
  onReviewCertificate,
}: {
  failure: RdpFailure;
  onClose: () => void;
  onReconnect: () => void;
  onReviewCertificate: () => void;
}): React.JSX.Element {
  const certificateChanged =
    failure.code === 'certificate-changed' || failure.code === 'certificate-new';
  return (
    <div role="alert" className="m-auto flex max-w-md flex-col items-center gap-5 px-6 py-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <TriangleAlert className="h-5 w-5" />
      </div>
      <RdpFailureBody failure={failure} />
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {certificateChanged && <Button onClick={onReviewCertificate}>Review certificate</Button>}
        <Button variant={certificateChanged ? 'soft' : 'default'} onClick={onReconnect}>
          <RefreshCw className="h-3.5 w-3.5" /> Reconnect
        </Button>
      </div>
    </div>
  );
}
