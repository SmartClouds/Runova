import type { AiAuditPhase, Project } from '@runova/core';
import { getCliDefinition } from '@runova/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ChevronDown,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Shield,
  Sparkles,
  TriangleAlert,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { launchPromptTab, projectCliId } from '@/lib/workspace/launch';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { AiAuditReport } from './AiAuditReport';
import { AiAuditWizard, type AiAuditWizardStep } from './AiAuditWizard';
import { AuditRunTracker } from './AuditRunTracker';
import { useAiAudit } from './useAiAudit';

/**
 * The AI audit half of the Security tab. It meets people in one of four places: never set up (an
 * introduction), set up but never run (a first run), running (the tracker), or finished (the
 * report). The wizard is the way into every run.
 */

const PHASE_BADGE: Record<
  AiAuditPhase,
  { label: string; variant: 'outline' | 'warning' | 'success' }
> = {
  starting: { label: 'Starting', variant: 'outline' },
  reconnaissance: { label: 'Running', variant: 'outline' },
  hunting: { label: 'Running', variant: 'outline' },
  validation: { label: 'Running', variant: 'outline' },
  verification: { label: 'Running', variant: 'outline' },
  reporting: { label: 'Running', variant: 'outline' },
  complete: { label: 'Complete', variant: 'success' },
  incomplete: { label: 'Incomplete', variant: 'warning' },
};

function joinProjectPath(folder: string, relative: string): string {
  const separator = folder.includes('\\') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${relative.replace(/[\\/]/g, separator)}`;
}

export function AiAuditPanel({ project }: { project: Project }): React.JSX.Element {
  const navigate = useNavigate();
  const audit = useAiAudit(project);
  const [wizardStep, setWizardStep] = useState<AiAuditWizardStep | null>(null);
  const { status, runs, run, selectedSummary, live } = audit;

  const openWizard = () => setWizardStep(status?.installed ? 'configure' : 'overview');

  const wizard = (
    <AiAuditWizard
      open={wizardStep !== null}
      onOpenChange={(open) => !open && setWizardStep(null)}
      project={project}
      audit={audit}
      initialStep={wizardStep ?? 'overview'}
    />
  );

  function openAgentTab(): void {
    navigate(`/workspace/${project.id}`);
  }

  function openFile(file: string, line: number): void {
    const store = useWorkspaceStore.getState();
    store.openProject(project.id);
    store.openFile(project.id, joinProjectPath(project.folderPath, file), {
      reveal: { line, column: 1 },
    });
    navigate(`/workspace/${project.id}`);
  }

  function fixWithAgent(prompt: string): void {
    const cliId = projectCliId(project);
    if (!cliId) {
      toast.error('Pick an agent for this project first', {
        description: 'Set the default CLI in Settings, or the project CLI on its Overview.',
      });
      return;
    }
    if (!launchPromptTab(project, { cliId, prompt })) return;
    navigate(`/workspace/${project.id}`);
    toast.success(`Starting ${getCliDefinition(cliId)?.label ?? 'the agent'}`, {
      description: 'The fix prompt goes in once it is ready. Read it over and press Enter.',
    });
  }

  function openPath(target: 'folder' | 'report'): void {
    if (!selectedSummary) return;
    window.runova.securityAudit
      .openPath(project.id, selectedSummary.runName, target)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'Could not open it.'),
      );
  }

  if (audit.statusLoading || audit.runsLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (audit.statusError && !status) {
    return (
      <Card className="glass border-destructive/40">
        <CardContent className="flex flex-wrap items-start gap-3 p-4">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Could not check the AI audit</p>
            <p className="mt-0.5 break-words text-xs text-muted-foreground">{audit.statusError}</p>
          </div>
          <Button variant="outline" onClick={() => void audit.refresh()}>
            <RefreshCw className="h-4 w-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (runs.length === 0) {
    const ready = status?.installed ?? false;
    return (
      <>
        <Card className="glass overflow-hidden">
          <CardContent className="grid gap-6 p-6 md:grid-cols-[1.3fr_1fr] md:items-center">
            <div className="space-y-3">
              <Badge variant="outline" className="gap-1">
                <Sparkles className="h-3 w-3" /> Cloudflare security-audit skill
              </Badge>
              <h3 className="text-lg font-semibold text-foreground">
                Find what scanners miss, then prove it
              </h3>
              <p className="text-sm text-muted-foreground">
                Your own agent audits {project.name} the way a security reviewer would: it maps the
                architecture, works through every entry point, and only reports a finding once it
                has reproduced it and a second agent has failed to disprove it.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button onClick={openWizard}>
                  <Shield className="h-4 w-4" />
                  {ready ? 'Start your first audit' : 'Set up AI audit'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {ready
                    ? 'The skill is installed in this project.'
                    : 'Installs the skill into this project first.'}
                </span>
              </div>
            </div>
            <ol className="space-y-2.5 text-sm">
              {[
                ['Install', 'The skill goes into this project, for the agents you pick.'],
                ['Run', 'Your agent works in a workspace tab while this tab follows along.'],
                ['Fix', 'Read verified findings with their proof, then hand them to an agent.'],
              ].map(([title, text], index) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {index + 1}
                  </span>
                  <span>
                    <span className="font-medium text-foreground">{title}</span>
                    <span className="block text-xs text-muted-foreground">{text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        {wizard}
      </>
    );
  }

  const dismissedLive =
    selectedSummary !== null &&
    audit.isDismissed(selectedSummary.runName) &&
    selectedSummary.phase !== 'complete' &&
    selectedSummary.phase !== 'incomplete';

  return (
    <div className="space-y-4">
      <Card className="glass">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <Sparkles className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">AI security audit</p>
              <p className="text-xs text-muted-foreground">
                {selectedSummary
                  ? `${selectedSummary.runName} · started ${new Date(selectedSummary.startedAt).toLocaleString()}`
                  : "Cloudflare's security-audit skill"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selectedSummary && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="gap-1.5">
                    {selectedSummary.runName}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Runs of this project</DropdownMenuLabel>
                  {runs.map((entry) => (
                    <DropdownMenuItem
                      key={entry.runName}
                      onClick={() => audit.selectRun(entry.runName)}
                    >
                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm">{entry.runName}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {new Date(entry.startedAt).toLocaleString()}
                          </span>
                        </span>
                        <Badge variant={PHASE_BADGE[entry.phase].variant}>
                          {entry.counts && entry.phase === 'complete'
                            ? `${entry.counts.confirmed} confirmed`
                            : PHASE_BADGE[entry.phase].label}
                        </Badge>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {selectedSummary?.hasReport && (
              <Button variant="outline" className="gap-1.5" onClick={() => openPath('report')}>
                <FileText className="h-4 w-4" /> REPORT.md
              </Button>
            )}
            <SimpleTooltip label="Open folder">
              <Button
                variant="outline"
                size="icon"
                aria-label="Open folder"
                onClick={() => openPath('folder')}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label={live ? 'A run is still going' : ''} wrapTrigger>
              <Button disabled={live} onClick={openWizard}>
                <Plus className="h-4 w-4" /> New audit
              </Button>
            </SimpleTooltip>
          </div>
        </CardContent>
      </Card>

      {status && !status.installed && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
          <p className="flex items-center gap-2 text-xs text-foreground">
            <TriangleAlert className="h-3.5 w-3.5 text-warning" />
            The security-audit skill is not installed in {project.name} any more. Earlier reports
            are still here.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setWizardStep('overview')}>
            Install it again
          </Button>
        </div>
      )}

      {live && selectedSummary ? (
        <AuditRunTracker
          run={run ?? selectedSummary}
          onOpenAgent={openAgentTab}
          onStopTracking={() => audit.stopTracking(selectedSummary.runName)}
        />
      ) : dismissedLive && selectedSummary ? (
        <Card className="glass">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              {selectedSummary.runName} has not finished and is no longer being tracked.
            </p>
            <Button variant="outline" size="sm" onClick={openAgentTab}>
              Open agent tab
            </Button>
          </CardContent>
        </Card>
      ) : run ? (
        <AiAuditReport
          run={run}
          projectName={project.name}
          onOpenFile={openFile}
          onFixWithAgent={fixWithAgent}
        />
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}

      {wizard}
    </div>
  );
}
