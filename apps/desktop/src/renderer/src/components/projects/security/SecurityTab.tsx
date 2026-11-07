import type { Project, SecurityScannerId } from '@runova/core';
import { getSecurityScanner, SECURITY_SCANNERS } from '@runova/core';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ChevronDown,
  History,
  Play,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import { ProjectEmptyState } from '@/components/projects/ProjectDetailChrome';
import { SECURITY_SETUP_ROUTE } from '@/components/tools/routes';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useProjectUiState } from '@/hooks/useProjectUiState';
import { confirmDialog } from '@/stores/confirmStore';
import { AiAuditPanel } from './aiAudit/AiAuditPanel';
import { ScannerPicker } from './ScannerPicker';
import { ScannerSetupDialog } from './ScannerSetupDialog';
import { ScanProgressPanel } from './ScanProgressPanel';
import { SecurityCopyMenu } from './SecurityCopyMenu';
import { SecurityReport } from './SecurityReport';
import { useSecurityScan } from './useSecurityScan';

type SecurityMode = 'scanners' | 'ai-audit';

/**
 * The project's Security section, in two halves: the local scanners (fast, rule based, one merged
 * report) and the AI audit (Cloudflare's security-audit skill, run by the user's own agent). The
 * half last used is remembered per project.
 */
export function SecurityTab({ project }: { project: Project }): React.JSX.Element {
  const [mode, setMode] = useProjectUiState<SecurityMode>('security.mode', 'scanners');
  return (
    <Tabs value={mode} onValueChange={(value) => setMode(value as SecurityMode)}>
      <TabsList aria-label="Security tools">
        <TabsTrigger value="scanners" className="gap-1.5">
          <Shield className="h-3.5 w-3.5" /> Scanners
        </TabsTrigger>
        <TabsTrigger value="ai-audit" className="gap-1.5">
          <Sparkles className="h-3.5 w-3.5" /> AI audit
        </TabsTrigger>
      </TabsList>
      <TabsContent value="scanners" className="mt-4">
        <ScannersView project={project} />
      </TabsContent>
      <TabsContent value="ai-audit" className="mt-4">
        <AiAuditPanel project={project} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * Pick scanners, run them, read one merged report, hand it to an agent to fix.
 *
 * Never hidden when nothing is installed. Someone who has not installed a scanner is exactly the
 * person who needs to be told these exist.
 */
function ScannersView({ project }: { project: Project }): React.JSX.Element {
  const navigate = useNavigate();
  const [setupScanner, setSetupScanner] = useState<SecurityScannerId | null>(null);
  const {
    preflight,
    preflightLoading,
    preflightError,
    refreshPreflight,
    report,
    reportLoading,
    viewingOldScan,
    viewScan,
    backToLatest,
    deleteScan,
    history,
    config,
    configLoading,
    saveConfig,
    selection,
    toggleScanner,
    running,
    runScannerIds,
    progress,
    runScan,
    cancel,
  } = useSecurityScan(project.id);

  const anyReady = preflight.some((p) => p.ready);
  const canRun = selection.length > 0 && !running;

  async function startScan(): Promise<void> {
    // Strix is an autonomous agent that runs the code and bills the user's own API key, so it
    // never starts on a single click the way the static scanners do.
    const paid = selection
      .map((id) => getSecurityScanner(id))
      .filter((scanner) => scanner?.costsMoney);
    if (paid.length > 0) {
      const confirmed = await confirmDialog({
        title: `Run ${paid.map((s) => s?.name).join(' and ')}?`,
        description:
          'This runs an autonomous agent that executes your code in a sandbox and drives an LLM to find and prove vulnerabilities. It can take up to an hour and spends tokens against your own API key.',
        confirmLabel: 'Run it',
      });
      if (!confirmed) return;
    }
    runScan();
  }

  const picker = (
    <ScannerPicker
      preflight={preflight}
      loading={preflightLoading}
      selection={selection}
      onToggle={toggleScanner}
      onConfigure={setSetupScanner}
      onRecheck={() => void refreshPreflight()}
      disabled={running}
      configLoading={configLoading}
    />
  );

  const setupDialog = (
    <ScannerSetupDialog
      // Keyed so each scanner's form starts from that scanner's saved settings rather than
      // inheriting a draft from whichever dialog was opened last.
      key={setupScanner ?? 'none'}
      scannerId={setupScanner}
      config={config}
      projectName={project.name}
      onClose={() => setSetupScanner(null)}
      onSave={(patch) => {
        saveConfig.mutate(patch, {
          onSuccess: () => toast.success('Scanner settings saved.'),
        });
      }}
      onSuggestLanguage={() => window.runova.security.suggestCodeqlLanguage(project.id)}
    />
  );

  // A failed check says nothing about what is installed, so it never shows the "install a scanner"
  // empty state. `running` guards this too: a scan started here keeps going in the main process.
  if (preflightError && !running) {
    return (
      <div className="space-y-4">
        <Card className="glass border-destructive/40">
          <CardContent className="flex flex-wrap items-start gap-3 p-4">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Could not check the scanners</p>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">{preflightError}</p>
            </div>
            <Button variant="outline" onClick={() => void refreshPreflight()}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          </CardContent>
        </Card>
        {report && <SecurityReport record={report} />}
      </div>
    );
  }

  if (!anyReady && !preflightLoading && !reportLoading && !report && !running) {
    return (
      <div className="space-y-4">
        <ProjectEmptyState
          icon={Shield}
          title="No security scanners installed yet"
          description="Dev Setup has a Security checklist that installs Semgrep, Trivy, CodeQL, Bearer, SonarQube and Strix once for every project. Come back here afterwards to scan this project and get one merged report you can hand to an agent."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => navigate(SECURITY_SETUP_ROUTE)}>
                <Shield className="h-4 w-4" /> Set up security tools
              </Button>
              <Button variant="outline" onClick={() => navigate('/tools?tab=security')}>
                Browse security tools
              </Button>
            </div>
          }
        />
        {picker}
        {setupDialog}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="glass">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <Shield className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Security scan</p>
              <p className="text-xs text-muted-foreground">
                {running
                  ? 'Running. You can leave this tab, the scan keeps going.'
                  : report
                    ? `Last run ${new Date(report.createdAt).toLocaleString()}`
                    : 'Pick the scanners to run against this project.'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {history.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="gap-1.5">
                    <History className="h-4 w-4" />
                    History
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                  <DropdownMenuLabel>Previous scans</DropdownMenuLabel>
                  {history.map((entry) => {
                    const when = new Date(entry.createdAt).toLocaleString();
                    return (
                      <div key={entry.id} className="flex items-center gap-1">
                        <DropdownMenuItem
                          className="min-w-0 flex-1"
                          onClick={() => void viewScan(entry.id)}
                        >
                          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                            <span className="truncate text-xs">{when}</span>
                            <Badge variant="outline">{entry.score}</Badge>
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          aria-label={`Delete scan from ${when}`}
                          className="shrink-0 px-2 text-muted-foreground"
                          onClick={() => void deleteScan(entry.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </DropdownMenuItem>
                      </div>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <SimpleTooltip label="Re-check which scanners are installed and configured">
              <Button
                variant="outline"
                size="icon"
                aria-label="Refresh scanner status"
                disabled={running}
                onClick={() => void refreshPreflight()}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </SimpleTooltip>

            {report && !running && <SecurityCopyMenu record={report} />}

            <SimpleTooltip
              label={selection.length === 0 ? 'Select at least one ready scanner first' : ''}
              wrapTrigger
            >
              <Button disabled={!canRun} onClick={() => void startScan()}>
                <Play className="h-4 w-4" />
                {running ? 'Scanning...' : report ? 'Scan again' : 'Run scan'}
              </Button>
            </SimpleTooltip>
          </div>
        </CardContent>
      </Card>

      {picker}

      {running && (
        <ScanProgressPanel selection={runScannerIds} progress={progress} onCancel={cancel} />
      )}

      {viewingOldScan && report && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Viewing a scan from {new Date(report.createdAt).toLocaleString()}.
          </p>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={backToLatest}>
            <ArrowLeft className="h-3.5 w-3.5" /> Back to latest
          </Button>
        </div>
      )}

      {/* A report is a result, not a starting state, so the card shimmers in its own shape rather
          than blanking the page. */}
      {reportLoading && !report ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-2 w-full rounded-full" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : report ? (
        <SecurityReport record={report} />
      ) : !running ? (
        <ProjectEmptyState
          icon={Shield}
          title="No scan yet"
          description={`${SECURITY_SCANNERS.filter((s) => preflight.find((p) => p.scannerId === s.id)?.ready).length} scanner(s) ready. Run one to get a merged report with a copy button that hands every finding to an agent.`}
        />
      ) : null}

      {setupDialog}
    </div>
  );
}
