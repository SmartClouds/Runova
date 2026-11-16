import type {
  AiAuditBucket,
  AiAuditFinding,
  AiAuditRunDetail,
  AiAuditSeverity,
} from '@runova/core';
import {
  AI_AUDIT_SEVERITIES,
  AI_AUDIT_SEVERITY_LABEL,
  auditFindingBucket,
  buildAiAuditFixPrompt,
  buildAiAuditValidationPrompt,
} from '@runova/core';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, Copy, Filter, Shield, Sparkles, TriangleAlert } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useProjectUiState } from '@/hooks/useProjectUiState';
import { cn } from '@/lib/utils';
import { AI_SEVERITY_STYLE, AuditFindingCard, type AuditTriageChange } from './AuditFindingCard';

/**
 * A finished AI audit. Built in the same visual language as the scanner report next door: a banner
 * that says how it went, a severity bar, then the findings. Confirmed findings lead, because those
 * are the ones that were reproduced and survived a second agent trying to disprove them.
 *
 * The audit's verdicts are where the work starts, not where it ends. Every finding can be handed
 * to an agent (to fix a confirmed one, or to prove and fix an unverified one), and what is learned
 * afterwards, by the user or by that agent, moves the finding between tabs.
 */

const TABS: { value: AiAuditBucket; label: string; empty: string }[] = [
  {
    value: 'confirmed',
    label: 'Confirmed',
    empty:
      'No confirmed findings. Nothing the audit tried could be reproduced end to end, and nothing has been proven since.',
  },
  {
    value: 'needs_validation',
    label: 'Needs validation',
    empty: 'Nothing is waiting to be checked.',
  },
  { value: 'fixed', label: 'Fixed', empty: 'Nothing has been marked fixed yet.' },
  { value: 'rejected', label: 'Rejected', empty: 'No candidate was disproved or ruled out.' },
];

function severityRank(finding: AiAuditFinding): number {
  return finding.verdict === 'confirmed'
    ? AI_AUDIT_SEVERITIES.indexOf(finding.severity.overall_severity)
    : AI_AUDIT_SEVERITIES.length;
}

function matches(finding: AiAuditFinding, needle: string): boolean {
  if (!needle) return true;
  return (
    finding.title.toLowerCase().includes(needle) ||
    finding.fingerprint.toLowerCase().includes(needle) ||
    finding.trace.some((step) => step.file.toLowerCase().includes(needle))
  );
}

export function AiAuditReport({
  run,
  projectName,
  onOpenFile,
  onFixWithAgent,
  onSetTriage,
}: {
  run: AiAuditRunDetail;
  projectName: string;
  onOpenFile: (file: string, line: number) => void;
  /** Starts an agent with the prompt. Used for fixing and for validating alike. */
  onFixWithAgent: (prompt: string) => void;
  /** Records what is now known about one finding, or clears it with `null`. */
  onSetTriage: (fingerprint: string, change: AuditTriageChange) => void | Promise<unknown>;
}): React.JSX.Element {
  const triage = run.triage;
  const buckets = useMemo(() => {
    const map = new Map<string, AiAuditBucket>();
    for (const finding of run.findings) {
      map.set(finding.fingerprint, auditFindingBucket(finding, triage));
    }
    return map;
  }, [run.findings, triage]);
  const bucketOf = (finding: AiAuditFinding): AiAuditBucket =>
    buckets.get(finding.fingerprint) ?? finding.verdict;

  const counts = useMemo(() => {
    const byBucket: Record<AiAuditBucket, number> = {
      confirmed: 0,
      needs_validation: 0,
      fixed: 0,
      rejected: 0,
    };
    const bySeverity: Record<AiAuditSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      informational: 0,
    };
    for (const finding of run.findings) {
      const bucket = buckets.get(finding.fingerprint) ?? finding.verdict;
      byBucket[bucket] += 1;
      if (bucket === 'confirmed' && finding.verdict === 'confirmed') {
        bySeverity[finding.severity.overall_severity] += 1;
      }
    }
    return { byBucket, bySeverity };
  }, [run.findings, buckets]);

  // Open on the tab with something to act on: confirmed findings, else the ones to validate.
  const [tab, setTab] = useState<AiAuditBucket>(() =>
    counts.byBucket.confirmed === 0 && counts.byBucket.needs_validation > 0
      ? 'needs_validation'
      : 'confirmed',
  );
  const [severityFilter, setSeverityFilter] = useProjectUiState<AiAuditSeverity[]>(
    'security.audit.severity',
    [],
  );
  const [search, setSearch] = useProjectUiState('security.audit.search', '');

  const promptOptions = { projectName, triage, outputDir: run.outputDir };
  const fixPrompt = buildAiAuditFixPrompt(run.findings, promptOptions);
  const validationPrompt = buildAiAuditValidationPrompt(run.findings, promptOptions);

  const needle = search.trim().toLowerCase();
  // A severity filter left over from another run only applies to severities this run has.
  const activeSeverities = severityFilter.filter((s) => counts.bySeverity[s] > 0);

  function visible(bucket: AiAuditBucket): AiAuditFinding[] {
    return run.findings
      .filter((finding) => bucketOf(finding) === bucket)
      .filter(
        (finding) =>
          bucket !== 'confirmed' ||
          activeSeverities.length === 0 ||
          (finding.verdict === 'confirmed' &&
            activeSeverities.includes(finding.severity.overall_severity)),
      )
      .filter((finding) => matches(finding, needle))
      .sort((a, b) => severityRank(a) - severityRank(b));
  }

  function promptFor(finding: AiAuditFinding): string {
    return bucketOf(finding) === 'confirmed'
      ? buildAiAuditFixPrompt([finding], promptOptions)
      : buildAiAuditValidationPrompt([finding], promptOptions);
  }

  async function copyPrompt(prompt: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success('Prompt copied.', { description: 'Paste it into any agent.' });
    } catch {
      toast.error('Could not copy the prompt.');
    }
  }

  const incomplete = run.phase === 'incomplete';
  const worst = AI_AUDIT_SEVERITIES.find((s) => counts.bySeverity[s] > 0) ?? null;
  const severityTotal = AI_AUDIT_SEVERITIES.reduce((sum, s) => sum + counts.bySeverity[s], 0);
  const confirmedTotal = counts.byBucket.confirmed;
  const pendingTotal = counts.byBucket.needs_validation;
  const fixedTotal = counts.byBucket.fixed;
  const noSandbox = run.metadata?.targetExecution?.available === false;
  // With nothing confirmed but leads left, the job is to check them, so the banner says that.
  const validating = !incomplete && confirmedTotal === 0 && pendingTotal > 0;

  const validateButtons = (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => void copyPrompt(validationPrompt)}
      >
        <Copy className="h-3.5 w-3.5" /> Copy validation prompt
      </Button>
      <Button size="sm" className="gap-1.5" onClick={() => onFixWithAgent(validationPrompt)}>
        <Sparkles className="h-3.5 w-3.5" /> Validate and fix with agent
      </Button>
    </>
  );

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex flex-wrap items-center gap-4 rounded-lg border px-4 py-3',
          incomplete || validating
            ? 'border-warning/40 bg-warning/10'
            : worst === 'critical' || worst === 'high'
              ? 'border-destructive/40 bg-destructive/10'
              : confirmedTotal > 0
                ? 'border-warning/40 bg-warning/10'
                : 'border-success/40 bg-success/10',
        )}
      >
        {incomplete || validating ? (
          <TriangleAlert className="h-7 w-7 shrink-0 text-foreground" />
        ) : confirmedTotal > 0 ? (
          <Shield className="h-7 w-7 shrink-0 text-foreground" />
        ) : (
          <CircleCheck className="h-7 w-7 shrink-0 text-foreground" />
        )}
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-semibold text-foreground">
            {incomplete
              ? 'This run stopped before it finished'
              : confirmedTotal > 0
                ? `${confirmedTotal} confirmed vulnerabilit${confirmedTotal === 1 ? 'y' : 'ies'} to fix`
                : validating
                  ? `Nothing confirmed yet: ${pendingTotal} finding${pendingTotal === 1 ? '' : 's'} need${pendingTotal === 1 ? 's' : ''} checking`
                  : fixedTotal > 0
                    ? 'Nothing left to fix'
                    : 'No confirmed vulnerabilities'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {incomplete
              ? `Reason: ${(run.metadata?.incompleteReason ?? 'not given').replace(/_/g, ' ')}. What it found so far is below; another run picks up the gaps.`
              : validating
                ? `${noSandbox ? `The audit could not run ${projectName}'s code in a sandbox, so it could not prove any lead.` : 'The audit could not prove these leads from here.'} An agent in your own checkout can: it writes a test for each one, fixes the real ones, and records the outcome so each finding moves to Confirmed, Fixed or Rejected.`
                : 'Each confirmed finding was reproduced, then re-checked by a separate agent that tried to disprove it. More runs tend to find more.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {fixPrompt ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void copyPrompt(fixPrompt)}
              >
                <Copy className="h-3.5 w-3.5" /> Copy fix prompt
              </Button>
              <Button size="sm" className="gap-1.5" onClick={() => onFixWithAgent(fixPrompt)}>
                <Sparkles className="h-3.5 w-3.5" /> Fix with agent
              </Button>
            </>
          ) : (
            validationPrompt && validateButtons
          )}
        </div>
      </div>

      {run.droppedFindings > 0 && (
        <p className="text-xs text-muted-foreground">
          {run.droppedFindings} record{run.droppedFindings === 1 ? '' : 's'} in findings.json could
          not be read and {run.droppedFindings === 1 ? 'is' : 'are'} left out. REPORT.md still has
          everything.
        </p>
      )}

      {worst && (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {AI_AUDIT_SEVERITIES.filter((s) => counts.bySeverity[s] > 0).map((severity) => (
            <SimpleTooltip
              key={severity}
              label={`${counts.bySeverity[severity]} ${AI_AUDIT_SEVERITY_LABEL[severity].toLowerCase()}`}
            >
              <div
                className={AI_SEVERITY_STYLE[severity].dot}
                style={{ width: `${(counts.bySeverity[severity] / severityTotal) * 100}%` }}
              />
            </SimpleTooltip>
          ))}
        </div>
      )}

      {run.ledger && run.ledger.total > 0 && (
        <p className="text-xs text-muted-foreground">
          {run.ledger.settled} of {run.ledger.total} coverage units settled
          {Object.entries(run.ledger.byStatus)
            .filter(([status]) => status !== 'covered')
            .map(([status, count]) => ` · ${count} ${status.replace(/_/g, ' ')}`)
            .join('')}
        </p>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as AiAuditBucket)}>
        <TabsList>
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              {entry.label}{' '}
              <Badge variant="outline" className="tabular-nums">
                {counts.byBucket[entry.value]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 p-2.5">
          <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {tab === 'confirmed' &&
            AI_AUDIT_SEVERITIES.filter((s) => counts.bySeverity[s] > 0).map((severity) => (
              <button
                key={severity}
                type="button"
                aria-pressed={activeSeverities.includes(severity)}
                onClick={() =>
                  setSeverityFilter((current) =>
                    current.includes(severity)
                      ? current.filter((s) => s !== severity)
                      : [...current, severity],
                  )
                }
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  activeSeverities.includes(severity)
                    ? 'border-primary/50 bg-primary/15 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary/30 hover:text-foreground',
                )}
              >
                {AI_AUDIT_SEVERITY_LABEL[severity]} {counts.bySeverity[severity]}
              </button>
            ))}
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by title or file..."
            className="h-7 w-52 text-xs"
          />
          {(activeSeverities.length > 0 || needle) && (
            <Button
              variant="ghost"
              size="sm"
              className="px-2.5"
              onClick={() => {
                setSeverityFilter([]);
                setSearch('');
              }}
            >
              Clear
            </Button>
          )}
        </div>

        {TABS.map((entry) => {
          const list = tab === entry.value ? visible(entry.value) : [];
          return (
            <TabsContent key={entry.value} value={entry.value} className="mt-3 space-y-2">
              {entry.value === 'needs_validation' && fixPrompt && validationPrompt && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    The audit could not prove these. An agent can test each one, fix the real ones
                    and move them along.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">{validateButtons}</div>
                </div>
              )}
              {list.length > 0 ? (
                list.map((finding) => (
                  <AuditFindingCard
                    key={finding.fingerprint}
                    finding={finding}
                    bucket={bucketOf(finding)}
                    triage={triage[finding.fingerprint]}
                    onOpenFile={onOpenFile}
                    onAgent={() => onFixWithAgent(promptFor(finding))}
                    onCopyPrompt={() => void copyPrompt(promptFor(finding))}
                    onSetTriage={(change) => void onSetTriage(finding.fingerprint, change)}
                  />
                ))
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {counts.byBucket[entry.value] > 0
                    ? 'Nothing matches those filters.'
                    : entry.empty}
                </p>
              )}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
