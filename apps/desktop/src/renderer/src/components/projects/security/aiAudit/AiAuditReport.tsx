import type {
  AiAuditFinding,
  AiAuditRunDetail,
  AiAuditSeverity,
  AiAuditVerdict,
} from '@runova/core';
import { AI_AUDIT_SEVERITIES, AI_AUDIT_SEVERITY_LABEL, buildAiAuditFixPrompt } from '@runova/core';
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
import { AI_SEVERITY_STYLE, AuditFindingCard } from './AuditFindingCard';

/**
 * A finished AI audit. Built in the same visual language as the scanner report next door: a banner
 * that says how it went, a severity bar, then the findings. Confirmed findings lead, because those
 * are the ones that were reproduced and survived a second agent trying to disprove them.
 */

const VERDICT_TABS: { value: AiAuditVerdict; label: string; empty: string }[] = [
  {
    value: 'confirmed',
    label: 'Confirmed',
    empty: 'No confirmed findings. Nothing the audit tried could be reproduced end to end.',
  },
  {
    value: 'needs_validation',
    label: 'Needs validation',
    empty: 'Nothing is waiting on a fact the audit could not check from here.',
  },
  { value: 'rejected', label: 'Rejected', empty: 'No candidate was disproved.' },
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
}: {
  run: AiAuditRunDetail;
  projectName: string;
  onOpenFile: (file: string, line: number) => void;
  onFixWithAgent: (prompt: string) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<AiAuditVerdict>('confirmed');
  const [severityFilter, setSeverityFilter] = useProjectUiState<AiAuditSeverity[]>(
    'security.audit.severity',
    [],
  );
  const [search, setSearch] = useProjectUiState('security.audit.search', '');

  const counts = useMemo(() => {
    const byVerdict: Record<AiAuditVerdict, number> = {
      confirmed: 0,
      needs_validation: 0,
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
      byVerdict[finding.verdict] += 1;
      if (finding.verdict === 'confirmed') bySeverity[finding.severity.overall_severity] += 1;
    }
    return { byVerdict, bySeverity };
  }, [run.findings]);

  const fixPrompt = useMemo(
    () => buildAiAuditFixPrompt(run.findings, { projectName }),
    [run.findings, projectName],
  );

  const needle = search.trim().toLowerCase();
  // A severity filter left over from another run only applies to severities this run has.
  const activeSeverities = severityFilter.filter((s) => counts.bySeverity[s] > 0);

  function visible(verdict: AiAuditVerdict): AiAuditFinding[] {
    return run.findings
      .filter((finding) => finding.verdict === verdict)
      .filter(
        (finding) =>
          finding.verdict !== 'confirmed' ||
          activeSeverities.length === 0 ||
          activeSeverities.includes(finding.severity.overall_severity),
      )
      .filter((finding) => matches(finding, needle))
      .sort((a, b) => severityRank(a) - severityRank(b));
  }

  async function copyFixPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fixPrompt);
      toast.success('Fix prompt copied.', { description: 'Paste it into any agent.' });
    } catch {
      toast.error('Could not copy the fix prompt.');
    }
  }

  const incomplete = run.phase === 'incomplete';
  const worst = AI_AUDIT_SEVERITIES.find((s) => counts.bySeverity[s] > 0) ?? null;
  const confirmedTotal = counts.byVerdict.confirmed;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          'flex items-center gap-4 rounded-lg border px-4 py-3',
          incomplete
            ? 'border-warning/40 bg-warning/10'
            : worst === 'critical' || worst === 'high'
              ? 'border-destructive/40 bg-destructive/10'
              : worst
                ? 'border-warning/40 bg-warning/10'
                : 'border-success/40 bg-success/10',
        )}
      >
        {incomplete ? (
          <TriangleAlert className="h-7 w-7 shrink-0 text-foreground" />
        ) : worst ? (
          <Shield className="h-7 w-7 shrink-0 text-foreground" />
        ) : (
          <CircleCheck className="h-7 w-7 shrink-0 text-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {incomplete
              ? 'This run stopped before it finished'
              : confirmedTotal === 0
                ? 'No confirmed vulnerabilities'
                : `${confirmedTotal} confirmed vulnerabilit${confirmedTotal === 1 ? 'y' : 'ies'}`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {incomplete
              ? `Reason: ${(run.metadata?.incompleteReason ?? 'not given').replace(/_/g, ' ')}. What it found so far is below; another run picks up the gaps.`
              : 'Each confirmed finding was reproduced, then re-checked by a separate agent that tried to disprove it. More runs tend to find more.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!fixPrompt}
            onClick={() => void copyFixPrompt()}
          >
            <Copy className="h-3.5 w-3.5" /> Copy fix prompt
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={!fixPrompt}
            onClick={() => onFixWithAgent(fixPrompt)}
          >
            <Sparkles className="h-3.5 w-3.5" /> Fix with agent
          </Button>
        </div>
      </div>

      {run.droppedFindings > 0 && (
        <p className="text-xs text-muted-foreground">
          {run.droppedFindings} record{run.droppedFindings === 1 ? '' : 's'} in findings.json could
          not be read and {run.droppedFindings === 1 ? 'is' : 'are'} left out. REPORT.md still has
          everything.
        </p>
      )}

      {confirmedTotal > 0 && (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {AI_AUDIT_SEVERITIES.filter((s) => counts.bySeverity[s] > 0).map((severity) => (
            <SimpleTooltip
              key={severity}
              label={`${counts.bySeverity[severity]} ${AI_AUDIT_SEVERITY_LABEL[severity].toLowerCase()}`}
            >
              <div
                className={AI_SEVERITY_STYLE[severity].dot}
                style={{ width: `${(counts.bySeverity[severity] / confirmedTotal) * 100}%` }}
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

      <Tabs value={tab} onValueChange={(value) => setTab(value as AiAuditVerdict)}>
        <TabsList>
          {VERDICT_TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              {entry.label}{' '}
              <Badge variant="outline" className="tabular-nums">
                {counts.byVerdict[entry.value]}
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

        {VERDICT_TABS.map((entry) => {
          const list = tab === entry.value ? visible(entry.value) : [];
          return (
            <TabsContent key={entry.value} value={entry.value} className="mt-3 space-y-2">
              {list.length > 0 ? (
                list.map((finding) => (
                  <AuditFindingCard
                    key={finding.fingerprint}
                    finding={finding}
                    onOpenFile={onOpenFile}
                  />
                ))
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {counts.byVerdict[entry.value] > 0
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
