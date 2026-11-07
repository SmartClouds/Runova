import type { AiAuditFinding, AiAuditSeverity, AiAuditTraceStep } from '@runova/core';
import { AI_AUDIT_SEVERITY_LABEL } from '@runova/core';
import { useState } from 'react';
import { ChevronDown } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
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

function Code({ children }: { children: string }): React.JSX.Element {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

export function AuditFindingCard({
  finding,
  onOpenFile,
}: {
  finding: AiAuditFinding;
  onOpenFile: (file: string, line: number) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const where = location(finding);
  const severity = finding.verdict === 'confirmed' ? finding.severity.overall_severity : null;
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
        {severity ? (
          <Badge variant={AI_SEVERITY_STYLE[severity].variant} className="shrink-0">
            {AI_AUDIT_SEVERITY_LABEL[severity]}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0">
            {finding.verdict === 'needs_validation' ? 'Unverified' : 'Rejected'}
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
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
