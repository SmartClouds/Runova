import type { AiAuditProfile, EffortLevel, Project } from '@runova/core';
import {
  AI_AUDIT_AGENTS,
  AI_AUDIT_PROFILES,
  aiAuditAgentForCli,
  buildSecurityAuditInstallCommand,
  buildSecurityAuditPrompt,
  cliLaunchOptions,
  EFFORT_LABELS,
  getCliDefinition,
  launchDefaultParts,
  nextAuditRunName,
  SECURITY_AUDIT_MIN_NODE,
  SECURITY_AUDIT_REPO_URL,
} from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RunSettingsFields } from '@/components/cli/RunSettingsFields';
import { CliLogo } from '@/components/cliLogos';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  ExternalLink,
  Play,
  RefreshCw,
  Shield,
  Spinner,
  TerminalSquare,
  TriangleAlert,
  X,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TerminalSlot } from '@/components/workspace/TerminalSlot';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { projectCliId } from '@/lib/workspace/launch';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { AiAuditState } from './useAiAudit';

/**
 * The guided way into Cloudflare's security-audit skill: check the machine, install the skill into
 * this project, pick the agent, depth and scope, read the prompt, start. Each step says what it is
 * about to do before it does it, and nothing runs that the user has not seen.
 */

export type AiAuditWizardStep = 'overview' | 'install' | 'configure' | 'review';

const STEP_LABEL: Record<AiAuditWizardStep, string> = {
  overview: 'Check',
  install: 'Install',
  configure: 'Configure',
  review: 'Start',
};

const NODE_URL = 'https://nodejs.org/';

/** A scope path the agent can resolve inside the project, or null for one it cannot. */
function normalizeScopePath(raw: string): string | null {
  const path = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  if (path.split('/').some((segment) => segment === '..')) return null;
  return path;
}

function CheckRow({
  ok,
  title,
  detail,
  action,
}: {
  ok: boolean;
  title: string;
  detail: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      {ok ? (
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function ChoiceCard({
  checked,
  disabled,
  onSelect,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        checked ? 'border-primary/60 bg-primary/10' : 'border-border bg-card/60 hover:bg-card',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-card/60',
      )}
    >
      {children}
      {checked && <Check className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}

/** The install's own terminal, folded away until someone wants to see what it is doing. */
function InstallTerminal({
  projectId,
  tabId,
}: {
  projectId: string;
  tabId: string;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const well = useRef<HTMLDivElement>(null);
  const tab = useWorkspaceStore((s) => s.workspaces[projectId]?.tabs[tabId]);
  // It opens at the bottom of a scrolling step, where most of it would be out of sight.
  useEffect(() => {
    if (expanded) well.current?.scrollIntoView?.({ block: 'nearest' });
  }, [expanded]);
  if (tab?.kind !== 'terminal') return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
        Terminal output
        <ChevronDown
          className={cn('ml-auto h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      {expanded && (
        <div ref={well} className="relative h-56 border-t border-border">
          <TerminalSlot projectId={projectId} tab={tab} focused={false} />
        </div>
      )}
    </div>
  );
}

export function AiAuditWizard({
  open,
  onOpenChange,
  project,
  audit,
  initialStep = 'overview',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  audit: AiAuditState;
  initialStep?: AiAuditWizardStep;
}): React.JSX.Element {
  const { status, installing } = audit;
  const [step, setStep] = useState<AiAuditWizardStep>(initialStep);
  // Fixed when the wizard opens, so the step bar keeps its Install step after the install lands.
  const [neededInstall, setNeededInstall] = useState(false);
  const [installAgents, setInstallAgents] = useState<string[] | null>(null);
  const [cliId, setCliId] = useState<string | null>(null);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<EffortLevel | undefined>(undefined);
  const [profile, setProfile] = useState<AiAuditProfile>('standard');
  const [scopeMode, setScopeMode] = useState<'all' | 'some'>('all');
  const [scopePaths, setScopePaths] = useState<string[]>([]);
  const [pathDraft, setPathDraft] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    enabled: open,
    meta: { silentLoading: true },
  });
  const installedCliIds = useMemo(
    () => new Set((cliQuery.data ?? []).filter((cli) => cli.installed).map((cli) => cli.id)),
    [cliQuery.data],
  );
  const readyAgents = AI_AUDIT_AGENTS.filter((agent) => installedCliIds.has(agent.cliId));

  // Start over each time the wizard opens.
  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setInstallAgents(null);
    setCliId(null);
    setModel(undefined);
    setEffort(undefined);
    setProfile('standard');
    setScopeMode('all');
    setScopePaths([]);
    setPathDraft('');
    setPathError(null);
    setStarting(false);
  }, [open, initialStep]);

  useEffect(() => {
    if (open && status) setNeededInstall((current) => current || !status.installed);
  }, [open, status]);

  // The CLI the project already uses, when it can run the audit; otherwise the first one that can.
  const preferredCliId = useMemo(() => {
    const own = projectCliId(project);
    if (own && aiAuditAgentForCli(own) && installedCliIds.has(own)) return own;
    return readyAgents[0]?.cliId ?? null;
  }, [project, installedCliIds, readyAgents]);
  const chosenCliId = cliId ?? preferredCliId;

  const defaultInstallAgents = useMemo(() => {
    const fromInstalled = readyAgents.map((agent) => agent.skillsAgent);
    if (fromInstalled.length > 0) return fromInstalled;
    const own = projectCliId(project);
    const mapped = own ? aiAuditAgentForCli(own)?.skillsAgent : null;
    return [mapped ?? 'claude-code'];
  }, [readyAgents, project]);
  const chosenInstallAgents = installAgents ?? defaultInstallAgents;

  // Once the install tab has put the skill in place, carry on to the next step by itself.
  useEffect(() => {
    if (step === 'install' && status?.installed) setStep('configure');
  }, [step, status?.installed]);

  const steps: AiAuditWizardStep[] =
    neededInstall || (status && !status.installed)
      ? ['overview', 'install', 'configure', 'review']
      : ['overview', 'configure', 'review'];
  const stepIndex = Math.max(0, steps.indexOf(step));

  const nodeOk = status?.node.meetsMinimum ?? false;
  const installCommand =
    chosenInstallAgents.length > 0 ? buildSecurityAuditInstallCommand(chosenInstallAgents) : '';
  const runsRoot = status?.runsRoot ?? '';
  const separator = runsRoot.includes('\\') ? '\\' : '/';
  const previewOutputDir = `${runsRoot}${separator}${nextAuditRunName(audit.runs.map((r) => r.runName))}`;
  const effectiveScope = scopeMode === 'some' ? scopePaths : [];
  const prompt = buildSecurityAuditPrompt({
    outputDir: previewOutputDir,
    profile,
    scopePaths: effectiveScope,
  });
  const chosenCli = chosenCliId ? getCliDefinition(chosenCliId) : undefined;
  const launchOptions = chosenCliId ? cliLaunchOptions(chosenCliId) : null;
  // What really goes on the command line: an effort the model cannot take is left off here.
  const launchParts = chosenCliId ? launchDefaultParts(chosenCliId, { model, effort }) : [];
  const runArgs = launchParts.flatMap((part) => part.args);
  const modelLabel = launchParts.some((part) => part.kind === 'model')
    ? (launchOptions?.models.find((option) => option.value === model)?.label ?? model)
    : undefined;
  const effortLabel =
    effort && launchParts.some((part) => part.kind === 'effort')
      ? EFFORT_LABELS[effort]
      : undefined;

  function pickCli(next: string): void {
    if (next === chosenCliId) return;
    setCliId(next);
    // Models and efforts belong to one CLI, so a choice for the last one does not carry over.
    setModel(undefined);
    setEffort(undefined);
  }

  function addScopePath(): void {
    const path = normalizeScopePath(pathDraft);
    if (!path) {
      setPathError('Use a folder inside the project, like src/api.');
      return;
    }
    setPathError(null);
    setScopePaths((current) => (current.includes(path) ? current : [...current, path]));
    setPathDraft('');
  }

  function next(): void {
    if (step === 'overview') {
      setStep(status?.installed ? 'configure' : 'install');
      return;
    }
    setStep(steps[stepIndex + 1]);
  }

  async function start(): Promise<void> {
    if (!chosenCliId) return;
    setStarting(true);
    const started = await audit.startAudit({
      cliId: chosenCliId,
      profile,
      scopePaths: effectiveScope,
      runArgs: runArgs.length > 0 ? runArgs : undefined,
      runLabel: [modelLabel, effortLabel].filter(Boolean).join(' · ') || undefined,
    });
    setStarting(false);
    if (!started) return;
    onOpenChange(false);
    toast.success(`The audit is starting in ${chosenCli?.label ?? 'the agent'}`, {
      description:
        'Follow it here on the Security tab. Its tab is in the project workspace if it asks you anything.',
    });
  }

  const canContinue =
    step === 'overview'
      ? status !== null
      : step === 'install'
        ? Boolean(status?.installed)
        : step === 'configure'
          ? chosenCliId !== null && (scopeMode === 'all' || scopePaths.length > 0)
          : true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4" /> Run an AI security audit
          </DialogTitle>
          <DialogDescription>
            {step === 'overview' &&
              "Cloudflare's security-audit skill, run by your own agent against this project."}
            {step === 'install' && `Install the skill into ${project.name}.`}
            {step === 'configure' && 'Choose who runs it, how deep it goes and what it covers.'}
            {step === 'review' && 'Read what the agent will be asked, then start.'}
          </DialogDescription>
        </DialogHeader>

        <ol className="flex items-center gap-1.5" aria-label="Wizard steps">
          {steps.map((entry, index) => (
            <li key={entry} className="flex flex-1 flex-col gap-1">
              <span
                className={cn(
                  'h-1 rounded-full transition-colors',
                  index <= stepIndex ? 'bg-primary' : 'bg-border',
                )}
              />
              <span
                className={cn(
                  'text-[11px]',
                  index === stepIndex ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {STEP_LABEL[entry]}
              </span>
            </li>
          ))}
        </ol>

        <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-1">
          {step === 'overview' && (
            <>
              <div className="space-y-2 rounded-lg border border-border bg-card/60 p-3 text-sm">
                <p className="font-medium text-foreground">What happens</p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  <li>
                    Your agent maps the project, hunts through each entry point and trust boundary,
                    and tries to prove every candidate it finds.
                  </li>
                  <li>
                    Each finding is handed to a fresh agent that tries to disprove it, so what
                    reaches the report has been checked twice.
                  </li>
                  <li>
                    It takes from about 20 minutes to a few hours and spends tokens on your own
                    agent plan. Nothing leaves your machine except what your agent normally sends.
                  </li>
                </ul>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-card/60 p-3">
                {status === null ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="h-3.5 w-3.5 animate-spin" /> Checking...
                  </p>
                ) : (
                  <>
                    <CheckRow
                      ok={status.installed}
                      title="security-audit skill"
                      detail={
                        status.installed
                          ? `Installed in ${status.locations.find((l) => l.scope === 'project')?.path}`
                          : `Not installed in ${project.name} yet. The next step installs it.`
                      }
                    />
                    <CheckRow
                      ok={nodeOk}
                      title={`Node.js ${SECURITY_AUDIT_MIN_NODE.split('.').slice(0, 2).join('.')} or later`}
                      detail={
                        status.node.found
                          ? `Found ${status.node.version}.${nodeOk ? '' : ' The installer and the skill need a newer one.'}`
                          : 'Not found. The installer and the skill run on Node.'
                      }
                      action={
                        !nodeOk && (
                          <Button
                            variant="soft"
                            size="sm"
                            onClick={() => void window.runova.shell.openExternal(NODE_URL)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" /> Get Node.js
                          </Button>
                        )
                      }
                    />
                    <CheckRow
                      ok={readyAgents.length > 0}
                      title="An agent that can run it"
                      detail={
                        cliQuery.isPending
                          ? 'Looking for installed agents...'
                          : readyAgents.length > 0
                            ? `${readyAgents.map((a) => getCliDefinition(a.cliId)?.label ?? a.cliId).join(', ')} ${readyAgents.length === 1 ? 'is' : 'are'} ready.`
                            : 'The audit needs an agent with sub-agents: Claude Code, Codex, OpenCode, Gemini CLI or Cursor. Install one from Dev Tools.'
                      }
                    />
                  </>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                The skill is open source under the MIT license:{' '}
                <button
                  type="button"
                  className="font-medium text-primary hover:text-primary/80"
                  onClick={() => void window.runova.shell.openExternal(SECURITY_AUDIT_REPO_URL)}
                >
                  cloudflare/security-audit-skill
                </button>
              </p>
            </>
          )}

          {step === 'install' && (
            <>
              <p className="text-sm text-foreground">
                Pick the agents to install it for. Each gets its own copy in its skills folder.
              </p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {AI_AUDIT_AGENTS.map((agent) => {
                  const label = getCliDefinition(agent.cliId)?.label ?? agent.cliId;
                  const checked = chosenInstallAgents.includes(agent.skillsAgent);
                  const id = `audit-install-${agent.skillsAgent}`;
                  return (
                    <label
                      key={agent.skillsAgent}
                      htmlFor={id}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                        checked
                          ? 'border-primary/60 bg-primary/10'
                          : 'border-border bg-card/60 hover:bg-card',
                      )}
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={installing}
                        onCheckedChange={() =>
                          setInstallAgents(
                            checked
                              ? chosenInstallAgents.filter((a) => a !== agent.skillsAgent)
                              : [...chosenInstallAgents, agent.skillsAgent],
                          )
                        }
                      />
                      <CliLogo cliId={agent.cliId} className="h-4 w-4 shrink-0" />
                      <span className="truncate text-sm text-foreground">{label}</span>
                      {installedCliIds.has(agent.cliId) && (
                        <Badge variant="outline" className="ml-auto">
                          Installed
                        </Badge>
                      )}
                    </label>
                  );
                })}
              </div>

              {installCommand && (
                <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Runs in {project.folderPath}
                    </p>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Copy the install command"
                      onClick={() => {
                        void navigator.clipboard.writeText(installCommand);
                        toast.success('Copied to clipboard.');
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                    {installCommand}
                  </p>
                </div>
              )}

              {!nodeOk && (
                <p className="flex items-start gap-2 text-xs text-warning">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  The installer needs Node.js{' '}
                  {SECURITY_AUDIT_MIN_NODE.split('.').slice(0, 2).join('.')} or later. Update Node,
                  then press Check again.
                </p>
              )}

              {installing ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                    <p className="flex items-center gap-2 text-sm text-foreground">
                      <Spinner className="h-3.5 w-3.5 animate-spin" />
                      Waiting for the install to finish in the Setup tab...
                    </p>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => void audit.refresh()}>
                        <RefreshCw className="h-3.5 w-3.5" /> Check again
                      </Button>
                      <Button variant="ghost" size="sm" onClick={audit.cancelInstall}>
                        <X className="h-3.5 w-3.5" /> Cancel
                      </Button>
                    </div>
                  </div>
                  {audit.installTabId && (
                    <InstallTerminal projectId={project.id} tabId={audit.installTabId} />
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={!nodeOk || chosenInstallAgents.length === 0}
                    onClick={() => audit.installSkill(chosenInstallAgents)}
                  >
                    <TerminalSquare className="h-4 w-4" /> Install into {project.name}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void audit.refresh()}>
                    <RefreshCw className="h-3.5 w-3.5" /> Check again
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                The command runs in a Setup tab in the project workspace and closes itself when it
                succeeds. If it fails, the tab stays open with the error.
              </p>
            </>
          )}

          {step === 'configure' && (
            <>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium text-foreground">
                  Which agent runs the audit
                </legend>
                <div role="radiogroup" aria-label="Agent" className="grid gap-1.5 sm:grid-cols-2">
                  {AI_AUDIT_AGENTS.map((agent) => {
                    const cli = getCliDefinition(agent.cliId);
                    const ready = installedCliIds.has(agent.cliId);
                    return (
                      <ChoiceCard
                        key={agent.cliId}
                        checked={chosenCliId === agent.cliId}
                        disabled={!ready}
                        onSelect={() => pickCli(agent.cliId)}
                      >
                        <CliLogo cliId={agent.cliId} className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm font-medium text-foreground">
                            {cli?.label ?? agent.cliId}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {ready ? 'Installed' : 'Not installed'}
                          </span>
                        </span>
                      </ChoiceCard>
                    );
                  })}
                </div>
                {readyAgents.length === 0 && !cliQuery.isPending && (
                  <p className="text-xs text-warning">
                    None of these agents is installed. Install one from the AI CLIs tab in Dev
                    Tools.
                  </p>
                )}
                {chosenCliId && launchOptions && (
                  <div className="pt-2">
                    <RunSettingsFields
                      hideCli
                      labels="form"
                      value={{ cliId: chosenCliId, model, effort }}
                      onChange={(next) => {
                        setModel(next.model);
                        setEffort(next.effort);
                      }}
                    />
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium text-foreground">How deep</legend>
                <div role="radiogroup" aria-label="Depth" className="grid gap-1.5 sm:grid-cols-3">
                  {AI_AUDIT_PROFILES.map((entry) => (
                    <ChoiceCard
                      key={entry.value}
                      checked={profile === entry.value}
                      onSelect={() => setProfile(entry.value)}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium text-foreground">{entry.label}</span>
                        <span className="text-[11px] text-muted-foreground">{entry.estimate}</span>
                        <span className="mt-1 text-xs text-muted-foreground">
                          {entry.description}
                        </span>
                      </span>
                    </ChoiceCard>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium text-foreground">What it covers</legend>
                <div role="radiogroup" aria-label="Scope" className="grid gap-1.5 sm:grid-cols-2">
                  <ChoiceCard checked={scopeMode === 'all'} onSelect={() => setScopeMode('all')}>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">The whole project</span>
                      <span className="text-xs text-muted-foreground">Recommended</span>
                    </span>
                  </ChoiceCard>
                  <ChoiceCard checked={scopeMode === 'some'} onSelect={() => setScopeMode('some')}>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium text-foreground">Only some folders</span>
                      <span className="text-xs text-muted-foreground">
                        Faster on a large repository
                      </span>
                    </span>
                  </ChoiceCard>
                </div>
                {scopeMode === 'some' && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Input
                        aria-label="Folder to include"
                        value={pathDraft}
                        placeholder="src/api"
                        onChange={(event) => {
                          setPathDraft(event.target.value);
                          setPathError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addScopePath();
                          }
                        }}
                      />
                      <Button variant="outline" onClick={addScopePath}>
                        Add
                      </Button>
                    </div>
                    {pathError && <p className="text-xs text-destructive">{pathError}</p>}
                    {scopePaths.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {scopePaths.map((path) => (
                          <span
                            key={path}
                            className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-foreground"
                          >
                            {path}
                            <button
                              type="button"
                              aria-label={`Remove ${path}`}
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() =>
                                setScopePaths((current) => current.filter((p) => p !== path))
                              }
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </fieldset>

              <p className="text-xs text-muted-foreground">
                Results go to a new folder in <span className="font-mono">{runsRoot}</span>, outside
                the project, so nothing is added to your repository.
              </p>
            </>
          )}

          {step === 'review' && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {chosenCliId && <CliLogo cliId={chosenCliId} className="h-4 w-4" />}
                <span className="font-medium text-foreground">{chosenCli?.label}</span>
                {modelLabel && <Badge variant="secondary">{modelLabel}</Badge>}
                {effortLabel && <Badge variant="secondary">{effortLabel} effort</Badge>}
                <Badge variant="secondary" className="capitalize">
                  {profile}
                </Badge>
                <Badge variant="outline">
                  {effectiveScope.length > 0
                    ? `${effectiveScope.length} folder${effectiveScope.length === 1 ? '' : 's'}`
                    : 'Whole project'}
                </Badge>
              </div>

              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    The prompt your agent gets
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Copy the prompt"
                    onClick={() => {
                      void navigator.clipboard.writeText(prompt);
                      toast.success('Copied to clipboard.');
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                  {prompt}
                </pre>
              </div>

              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  The agent opens in a tab in the project workspace and starts on its own.
                </li>
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  It may ask you to approve writing to the results folder or running a check. Keep
                  an eye on its tab for the first few minutes.
                </li>
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  This tab follows the run and shows the report when it is done. Running it again
                  later tends to find more.
                </li>
              </ul>
            </>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            disabled={stepIndex === 0 || starting}
            onClick={() => setStep(steps[stepIndex - 1])}
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {step === 'review' ? (
            <Button disabled={!chosenCliId || starting} onClick={() => void start()}>
              {starting ? (
                <Spinner className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Start audit
            </Button>
          ) : (
            <Button disabled={!canContinue} onClick={next}>
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
