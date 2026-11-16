import type {
  AiAuditBucket,
  AiAuditFinding,
  AiAuditSeverity,
  AiAuditTraceStep,
  AiAuditTriageEntry,
  AiAuditTriageStatus,
} from '@runova/core';
import { AI_AUDIT_SEVERITY_LABEL } from '@runova/core';
import { useState } from 'react';
import { Ban, Check, ChevronDown, Copy, Sparkles, Undo, Wrench } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SEVERITY_BADGE } from '../FindingRow';

/**
 * One audit finding. Collapsed it is a single line (severity, title, where); opened it reads top
 * to bottom the way the skill reasons: what is wrong, how input gets there, the proof, the fix.
 */

/** The scanner report's colors, so a high reads the same in both reports. */
export const AI_SEVERITY_STYLE: Record<AiAuditSeverity, (typeof SEVERITY_BADGE)['high']> = {
  critical: SEVERITY_BADGE.critical,
  high: SEVERITY_BADGE.high,
  medium: SEVERITY_BADGE.medium,
  low: SEVERITY_BADGE.low,
  informational: SEVERITY_BADGE.info,
};

const TRACE_KIND_LABEL: Record<AiAuditTraceStep['kind'], string> = {
  entrypoint: 'Entry point',
  propagation: 'Passes through',
  sink: 'Sink',
};

const TRIAGE_LABEL: Record<AiAuditTriageStatus, string> = {
  confirmed: 'Confirmed',
  not_a_bug: 'Not a bug',
  fixed: 'Fixed',
};

export type AuditTriageChange = { status: AiAuditTriageStatus; note?: string } | null;

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function location(finding: AiAuditFinding): string | null {
  const step = finding.trace.find((entry) => entry.kind === 'sink') ?? finding.trace.at(-1);
  return step ? `${step.file}:${step.line}` : null;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function FileLink({
  file,
  line,
  onOpenFile,
}: {
  file: string;
  line: number;
  onOpenFile: (file: string, line: number) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onOpenFile(file, line)}
      className="font-mono text-xs font-medium text-primary hover:text-primary/80"
    >
      {file}:{line}
    </button>
  );
}

function StatusBadge({
  finding,
  triage,
}: {
  finding: AiAuditFinding;
  triage: AiAuditTriageEntry | undefined;
}): React.JSX.Element {
  if (triage?.status === 'fixed') {
    return (
      <Badge variant="success" className="shrink-0">
        Fixed
      </Badge>
    );
  }
  if (triage?.status === 'not_a_bug') {
    return (
      <Badge variant="outline" className="shrink-0">
        Not a bug
      </Badge>
    );
  }
  if (finding.verdict === 'confirmed') {
    const severity = finding.severity.overall_severity;
    return (
      <Badge variant={AI_SEVERITY_STYLE[severity].variant} className="shrink-0">
        {AI_AUDIT_SEVERITY_LABEL[severity]}
      </Badge>
    );
  }
  if (triage?.status === 'confirmed') {
    return (
      <Badge variant="warning" className="shrink-0">
        Confirmed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0">
      {finding.verdict === 'needs_validation' ? 'Unverified' : 'Rejected'}
    </Badge>
  );
}

function formatWhen(at: string): string {
  const time = Date.parse(at);
  return Number.isNaN(time) ? '' : ` on ${new Date(time).toLocaleString()}`;
}

/**
 * What can be done with the finding from here: hand it to an agent (to fix a confirmed one, or to
 * prove and fix an unverified one), or record what is now known about it.
 */
function FindingActions({
  finding,
  bucket,
  triage,
  onAgent,
  onCopyPrompt,
  onSetTriage,
}: {
  finding: AiAuditFinding;
  bucket: AiAuditBucket;
  triage: AiAuditTriageEntry | undefined;
  onAgent: () => void;
  onCopyPrompt: () => void;
  onSetTriage: (change: AuditTriageChange) => void;
}): React.JSX.Element {
  const canPrompt = bucket === 'confirmed' || bucket === 'needs_validation';
  const mark = (status: AiAuditTriageStatus) => () => onSetTriage({ status });

  return (
    <div className="space-y-2">
      {triage && (
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-foreground">
            <span className="font-medium">
              Marked {TRIAGE_LABEL[triage.status].toLowerCase()} by{' '}
              {triage.by === 'you' ? 'you' : 'an agent'}
              {formatWhen(triage.at)}.
            </span>{' '}
            {triage.note && <span className="text-muted-foreground">{triage.note}</span>}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2"
            onClick={() => onSetTriage(null)}
          >
            <Undo className="h-3.5 w-3.5" />
            Back to {finding.verdict === 'needs_validation' ? 'unverified' : finding.verdict}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {canPrompt && (
          <>
            <Button size="sm" className="h-7 gap-1.5" onClick={onAgent}>
              <Sparkles className="h-3.5 w-3.5" />
              {bucket === 'confirmed' ? 'Fix with agent' : 'Validate and fix with agent'}
            </Button>
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={onCopyPrompt}>
              <Copy className="h-3.5 w-3.5" /> Copy prompt
            </Button>
          </>
        )}
        {!triage && (
          <span className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
            {bucket !== 'confirmed' && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                onClick={mark('confirmed')}
              >
                <Check className="h-3.5 w-3.5" /> Mark confirmed
              </Button>
            )}
            {bucket !== 'rejected' && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                onClick={mark('not_a_bug')}
              >
                <Ban className="h-3.5 w-3.5" /> Not a bug
              </Button>
            )}
            {bucket !== 'rejected' && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2"
                onClick={mark('fixed')}
              >
                <Wrench className="h-3.5 w-3.5" /> Mark fixed
              </Button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function Code({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

export function AuditFindingCard({
  finding,
  bucket = finding.verdict,
  triage,
  onOpenFile,
  onAgent,
  onCopyPrompt,
  onSetTriage,
}: {
  finding: AiAuditFinding;
  /** Where the finding is listed once triage is applied. */
  bucket?: AiAuditBucket;
  triage?: AiAuditTriageEntry;
  onOpenFile: (file: string, line: number) => void;
  /** Hands this one finding to an agent: to fix it, or to prove and fix it. */
  onAgent?: () => void;
  onCopyPrompt?: () => void;
  onSetTriage?: (change: AuditTriageChange) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const where = location(finding);
  const regionId = `audit-finding-${finding.fingerprint.replace(/[^\w-]/g, '-')}`;

  return (
    <div className="rounded-lg border border-border bg-card/60">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <StatusBadge finding={finding} triage={triage} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm font-medium text-foreground',
            bucket === 'fixed' && 'text-muted-foreground',
          )}
        >
          {finding.title}
        </span>
        {where && (
          <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground md:inline">
            {where}
          </span>
        )}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <section
          id={regionId}
          aria-label={finding.title}
          className="space-y-4 border-t border-border px-3 py-3 text-sm"
        >
          {onAgent && onCopyPrompt && onSetTriage && (
            <FindingActions
              finding={finding}
              bucket={bucket}
              triage={triage}
              onAgent={onAgent}
              onCopyPrompt={onCopyPrompt}
              onSetTriage={onSetTriage}
            />
          )}

          {finding.description && <p className="text-foreground">{finding.description}</p>}

          {finding.verdict === 'confirmed' ? (
            <>
              {finding.root_cause && (
                <Section title="Root cause">
                  <p className="text-foreground">{finding.root_cause}</p>
                </Section>
              )}
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">Confidence {finding.confidence.score}</Badge>
                <Badge variant="outline">Likelihood {finding.severity.likelihood.score}</Badge>
                <Badge variant="outline">Impact {finding.severity.impact.score}</Badge>
              </div>
            </>
          ) : (
            finding.claimed_root_cause && (
              <Section title="Claimed root cause">
                <p className="text-foreground">{finding.claimed_root_cause}</p>
              </Section>
            )
          )}

          <Section title="How input gets there">
            <ol className="space-y-2 border-l border-border pl-3">
              {finding.trace.map((step) => (
                <li key={`${step.kind}-${step.file}-${step.line}`} className="space-y-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={step.kind === 'sink' ? 'destructive' : 'secondary'}>
                      {TRACE_KIND_LABEL[step.kind]}
                    </Badge>
                    <FileLink file={step.file} line={step.line} onOpenFile={onOpenFile} />
                    {step.scope && (
                      <span className="text-xs text-muted-foreground">{step.scope}</span>
                    )}
                  </span>
                  {step.description && (
                    <p className="text-xs text-muted-foreground">{step.description}</p>
                  )}
                </li>
              ))}
            </ol>
          </Section>

          {finding.evidence.length > 0 && (
            <Section title="Evidence">
              <ul className="space-y-1">
                {finding.evidence.map((item) => (
                  <li key={`${item.file}-${item.line}-${item.description}`} className="text-xs">
                    <FileLink file={item.file} line={item.line} onOpenFile={onOpenFile} />{' '}
                    <span className="text-muted-foreground">{item.description}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {finding.verdict === 'confirmed' && (
            <>
              {finding.conditions.length > 0 && (
                <Section title="Conditions">
                  <div className="flex flex-wrap gap-1.5">
                    {finding.conditions.map((condition) => (
                      <Badge
                        key={`${condition.kind}-${condition.description}`}
                        variant="outline"
                        title={humanize(condition.kind)}
                      >
                        {condition.description}
                      </Badge>
                    ))}
                  </div>
                </Section>
              )}

              <Section title="How it was proven">
                {finding.execution.attacker_perspective && (
                  <p className="text-xs text-muted-foreground">
                    Attacker: {finding.execution.attacker_perspective}
                  </p>
                )}
                {finding.execution.instructions.length > 0 && (
                  <ol className="list-decimal space-y-0.5 pl-5 text-xs text-foreground">
                    {finding.execution.instructions.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
                {finding.execution.payloads.map((payload) => (
                  <Code key={payload}>{payload}</Code>
                ))}
                {finding.execution.observed_result && (
                  <p className="text-xs text-foreground">
                    Result: {finding.execution.observed_result}
                  </p>
                )}
              </Section>

              <Section title="Fix">
                {finding.remediation.strategy && (
                  <p className="text-foreground">{finding.remediation.strategy}</p>
                )}
                {(finding.remediation.code_changes ?? []).map((change) => (
                  <div key={change.file_name} className="space-y-1">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {change.file_name}
                    </p>
                    <Code>{change.fixed_code}</Code>
                  </div>
                ))}
              </Section>
            </>
          )}

          {finding.verdict === 'needs_validation' && (
            <>
              {finding.blockers.length > 0 && (
                <Section title="What is still unknown">
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-foreground">
                    {finding.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </Section>
              )}
              {(finding.validation_plan.local || finding.validation_plan.deployment) && (
                <Section title="How to check it">
                  {finding.validation_plan.local && (
                    <p className="text-xs text-foreground">
                      Locally: {finding.validation_plan.local}
                    </p>
                  )}
                  {finding.validation_plan.deployment && (
                    <p className="text-xs text-foreground">
                      In a deployment: {finding.validation_plan.deployment}
                    </p>
                  )}
                </Section>
              )}
            </>
          )}

          {finding.verdict === 'rejected' && finding.reason && (
            <Section title="Why it was rejected">
              <p className="text-foreground">{finding.reason}</p>
            </Section>
          )}

          <p className="font-mono text-[10px] text-muted-foreground">{finding.fingerprint}</p>
        </section>
      )}
    </div>
  );
}
