import type { AiApprovalPreview } from '@shared/aiAccessTypes';
import { useMemo } from 'react';
import { diffLines, diffStats, MASK, maskEnvLine } from '@/lib/aiAccess/lineDiff';
import { cn } from '@/lib/utils';

/**
 * The body of an AI access approval: what the agent wants to change, send or read, in the shape
 * that suits it. Secret values are masked until the user chooses to see them.
 */

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-success/12 text-success',
  POST: 'bg-primary/12 text-primary',
  PUT: 'bg-warning/12 text-warning',
  PATCH: 'bg-warning/12 text-warning',
  DELETE: 'bg-destructive/12 text-destructive',
};

function Fields({
  fields,
  reveal,
}: {
  fields: NonNullable<AiApprovalPreview['fields']>;
  reveal: boolean;
}): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-3 text-xs">
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd
            className={cn(
              'min-w-0 break-words',
              (field.mono || field.secret) && 'font-mono',
              field.secret && !reveal && 'tracking-widest text-muted-foreground',
            )}
          >
            {field.secret && !reveal ? MASK : field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Diff({
  diff,
  reveal,
}: {
  diff: NonNullable<AiApprovalPreview['diff']>;
  reveal: boolean;
}): React.JSX.Element {
  const lines = useMemo(() => diffLines(diff.before, diff.after), [diff.before, diff.after]);
  const stats = diffStats(lines);
  const show = (text: string) => (diff.secret && !reveal ? maskEnvLine(text) : text);
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/30">
      <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono font-medium">{diff.fileName}</span>
        <span className="font-mono text-success">+{stats.added}</span>
        <span className="font-mono text-destructive">−{stats.removed}</span>
      </div>
      <pre
        dir="ltr"
        className="max-h-60 overflow-auto py-1.5 font-mono text-[11.5px] leading-relaxed"
      >
        {lines.map((line, index) => (
          <div
            // Lines repeat, so the position is the only stable key; the diff never reorders.
            key={index}
            className={cn(
              'flex gap-2 px-3.5',
              line.kind === 'added' && 'bg-success/10',
              line.kind === 'removed' && 'bg-destructive/10',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'w-3 shrink-0 select-none text-center',
                line.kind === 'added' && 'text-success',
                line.kind === 'removed' && 'text-destructive',
                line.kind === 'same' && 'text-muted-foreground/50',
              )}
            >
              {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
            </span>
            <span
              className={cn(
                'min-w-0 whitespace-pre-wrap break-all',
                line.kind === 'same' && 'text-muted-foreground',
              )}
            >
              {show(line.text)}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function Request({
  request,
}: {
  request: NonNullable<AiApprovalPreview['request']>;
}): React.JSX.Element {
  const method = request.method.toUpperCase();
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/30 text-xs">
      <div className="flex items-center gap-2.5 px-3.5 py-2.5">
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold',
            METHOD_TONE[method] ?? 'bg-foreground/[0.06] text-foreground/80',
          )}
        >
          {method}
        </span>
        <span dir="ltr" className="min-w-0 flex-1 break-all font-mono">
          {request.url}
        </span>
      </div>
      {request.headers?.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border/70 px-3.5 py-2.5 font-mono">
          {request.headers.map((header) => (
            <div key={header.key} className="contents">
              <dt className="text-muted-foreground">{header.key}</dt>
              <dd className="min-w-0 break-all">{header.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {request.body ? (
        <pre
          dir="ltr"
          className="max-h-40 overflow-auto whitespace-pre-wrap break-all border-t border-border/70 px-3.5 py-2.5 font-mono leading-relaxed"
        >
          {request.body}
        </pre>
      ) : null}
    </div>
  );
}

export function hasSecrets(preview: AiApprovalPreview): boolean {
  return Boolean(preview.diff?.secret || preview.fields?.some((field) => field.secret));
}

export function ApprovalPreview({
  preview,
  reveal,
}: {
  preview: AiApprovalPreview;
  reveal: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {preview.summary ? (
        <p className="text-sm leading-relaxed text-foreground/85">{preview.summary}</p>
      ) : null}
      {preview.fields?.length ? <Fields fields={preview.fields} reveal={reveal} /> : null}
      {preview.request ? <Request request={preview.request} /> : null}
      {preview.diff ? <Diff diff={preview.diff} reveal={reveal} /> : null}
    </div>
  );
}
