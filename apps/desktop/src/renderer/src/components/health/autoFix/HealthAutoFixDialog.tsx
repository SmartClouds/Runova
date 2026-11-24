import {
  CLI_REGISTRY,
  cliLaunchOptions,
  defaultEffortFor,
  EFFORT_LABELS,
  type EffortLevel,
  getCliDefinition,
  type Project,
  runProfileForTargetAI,
} from '@runova/core';
import type { AssistantMode } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { HealthTargetSummary } from '@shared/healthTypes';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { EffortPicker } from '@/components/cli/RunSettingsFields';
import { cliOptionIcon } from '@/components/cliLogos';
import { Copy, Robot, Run, TerminalSquare, Wand2 } from '@/components/icons';
import {
  FOOTER_HAIRLINE,
  Notice,
  Problem,
  SECTION_HEADING,
  SECTION_WELL,
  segmentClass,
} from '@/components/pageKit';
import { projectOption } from '@/components/projects/projectOptions';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useAgentChoices } from '@/components/workspace/useAgentChoices';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { launchPromptTab } from '@/lib/workspace/launch';
import {
  type AssistantAiChoice,
  isRunActive,
  SETTINGS_AI,
  useDeployAssistantStore,
} from '@/stores/deployAssistantStore';
import { healthFixPromptKey } from '../healthFixPrompt';
import {
  deployAppRoute,
  deployContext,
  type WorkspacePick,
  workspaceRunArgs,
  workspaceRunLabel,
} from './autoFixView';

/**
 * Auto fix for a monitor that is down or degraded. The main process builds the prompt from the
 * last (redacted) report and incident; the user reads or edits it, picks the project (the
 * monitor's own to start with), and hands it to an agent in one of two places: a terminal in the
 * project's Workspace, with the CLI, model, effort and permission mode picked here, or the Deploy
 * AI on the app the monitor was added from, with its AI, model, effort and command mode. Or they
 * copy the prompt and take it elsewhere.
 */

type Destination = 'workspace' | 'deploy';

/** Picker value for the OpenAI, Gemini or Ollama provider set in Settings. */
const SETTINGS_PROVIDER = '__settings__';
/** Picker value for "keep the command mode the server has now". */
const KEEP_MODE = 'keep';

const COMMAND_MODES: ReadonlyArray<{ value: AssistantMode | typeof KEEP_MODE; label: string }> = [
  { value: KEEP_MODE, label: 'Keep as it is' },
  { value: 'approveEveryCommand', label: 'Approve every command' },
  { value: 'autoRunDiagnostics', label: 'Auto-run diagnostics' },
];

/** A row of mutually exclusive choices, drawn like the other segmented controls. */
function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-0.5 rounded-full bg-foreground/8 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            segmentClass(option.value === value),
            'h-7 flex-1 whitespace-nowrap px-2.5 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
          {label}
        </Label>
      ) : (
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      )}
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function HealthAutoFixDialog({
  target,
  projects,
  open,
  onOpenChange,
}: {
  target: HealthTargetSummary;
  projects: readonly Project[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[min(60rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        {/* Mounted only while open, so every opening starts from the monitor's own project. */}
        {open ? (
          <AutoFixBody target={target} projects={projects} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AutoFixBody({
  target,
  projects,
  onDone,
}: {
  target: HealthTargetSummary;
  projects: readonly Project[];
  onDone: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const ids = useId();
  const app = target.appLink ?? null;

  const promptQuery = useQuery({
    queryKey: healthFixPromptKey(target.id),
    queryFn: async () => (await window.runova.health.fixPrompt(target.id)) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: { silentLoading: true },
  });
  // Until the user types, the prompt follows what main built; after that it is theirs.
  const [edited, setEdited] = useState<string | null>(null);
  const prompt = edited ?? promptQuery.data ?? '';
  const nothingToFix = promptQuery.isSuccess && promptQuery.data === null;
  const promptError = promptQuery.isError
    ? `Could not build the fix prompt: ${promptQuery.error.message}`
    : nothingToFix
      ? 'Nothing is failing right now, so there is nothing to fix.'
      : null;
  const ready = prompt.trim().length > 0;

  const [projectId, setProjectId] = useState(target.projectId);
  const project = projects.find((one) => one.id === projectId) ?? null;
  const [destination, setDestination] = useState<Destination>('workspace');

  // Workspace: the project's own CLI first, until the user picks another.
  const choices = useAgentChoices(project);
  const [pick, setPick] = useState<WorkspacePick | null>(null);
  const cliId = pick?.cliId ?? choices.installed[0]?.cli.id ?? null;
  const workspace: WorkspacePick | null = cliId
    ? { cliId, model: pick?.model, effort: pick?.effort, mode: pick?.mode }
    : null;
  const options = cliId ? cliLaunchOptions(cliId) : null;
  const mode = options?.modes.find((one) => one.id === workspace?.mode);
  const cliOptions = [...choices.installed, ...choices.missing].map(({ cli, installed }) => ({
    value: cli.id,
    label: installed ? cli.name : `${cli.name} (not installed)`,
    icon: cliOptionIcon(cli.id),
  }));

  // Deploy AI: the drawer's own last picks to start with, since they are kept for its next run.
  const serverId = app?.serverId ?? '';
  const lastAi = useDeployAssistantStore((state) => state.ai);
  const lastAccess = useDeployAssistantStore((state) => state.projects[serverId]);
  const busy = useDeployAssistantStore((state) =>
    serverId ? isRunActive(state.runs[serverId]?.progress) : false,
  );
  const cliStatus = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    meta: { silentLoading: true },
  });
  const promptClis = CLI_REGISTRY.filter(
    (cli) => cli.promptCommand && cliStatus.data?.find((one) => one.id === cli.id)?.installed,
  );
  const [ai, setAi] = useState<AssistantAiChoice>(lastAi);
  const aiCli = promptClis.some((cli) => cli.id === ai.cliId) ? ai.cliId : null;
  const profile = aiCli ? runProfileForTargetAI(aiCli) : null;
  const aiModels = profile && !profile.generic ? profile.models : [];
  const aiModel = aiModels.find((one) => one.id === ai.modelId);
  const aiEfforts = aiModel?.efforts ?? [];
  // A model with efforts but none picked runs on its default one, so that is what shows.
  const aiEffort =
    ai.effort && aiEfforts.includes(ai.effort)
      ? ai.effort
      : aiModel
        ? (defaultEffortFor(aiModel) ?? null)
        : null;
  const [commandMode, setCommandMode] = useState<AssistantMode | typeof KEEP_MODE>(KEEP_MODE);
  const [allowEdits, setAllowEdits] = useState(lastAccess?.allowEdits ?? false);

  function copyPrompt(): void {
    void navigator.clipboard.writeText(prompt).then(
      () => toast.success('Prompt copied'),
      () => toast.error('Could not copy the prompt'),
    );
  }

  function openInWorkspace(run: boolean): void {
    if (!ready || !project || !workspace) return;
    const tabId = launchPromptTab(project, {
      cliId: workspace.cliId,
      prompt,
      runArgs: workspaceRunArgs(workspace),
      runLabel: workspaceRunLabel(workspace),
      submit: run,
    });
    if (!tabId) return;
    onDone();
    navigate(`/workspace/${project.id}`);
    const name = getCliDefinition(workspace.cliId)?.name ?? 'the agent';
    toast.success(`Starting ${name}`, {
      description: run
        ? 'The prompt goes in and runs as soon as the CLI is ready.'
        : 'The prompt goes in as soon as it is ready. Press Enter in the tab to run it.',
    });
  }

  function openInDeploy(): void {
    if (!ready || !app || busy) return;
    const store = useDeployAssistantStore.getState();
    // A fresh chat about the app, not a follow-up to whatever was on screen before.
    if (store.runs[app.serverId]) store.reset(app.serverId);
    store.dismissApp(app.serverId, null);
    const choice: AssistantAiChoice = aiCli
      ? { cliId: aiCli, modelId: aiModel?.id ?? null, effort: aiModel ? aiEffort : null }
      : SETTINGS_AI;
    store.setAi(choice);
    if (aiCli && project) store.setProject(app.serverId, { projectId: project.id, allowEdits });
    store.requestMode(app.serverId, commandMode === KEEP_MODE ? null : commandMode);
    store.open(app.serverId, { prompt, context: deployContext(target) });
    onDone();
    navigate(deployAppRoute(app));
    toast.success('The Deploy AI is ready', {
      description: 'Check the prompt in the drawer and press Start to run it.',
    });
  }

  return (
    <>
      <DialogHeader className="px-5 py-4 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
        <DialogTitle className="flex items-center gap-2 text-base">
          <Wand2 className="h-4 w-4 text-primary" />
          Auto fix {target.name}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {[target.headline, target.serverLabel].filter(Boolean).join(' · ') ||
            'Hand the failure to an AI agent.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 lg:flex-row">
        <div className="flex min-h-[16rem] min-w-0 flex-1 flex-col gap-2">
          <p className={SECTION_HEADING}>Prompt</p>
          {promptQuery.isPending ? (
            <div className={cn(SECTION_WELL, 'space-y-2')}>
              <p className="text-xs text-muted-foreground">
                Collecting the errors from the last check…
              </p>
              {Array.from({ length: 6 }, (_, i) => (
                <span
                  key={i}
                  className="shimmer block h-3 rounded"
                  style={{ width: `${92 - i * 9}%` }}
                />
              ))}
            </div>
          ) : promptError && edited === null ? (
            <Problem message={promptError} onRetry={() => void promptQuery.refetch()} />
          ) : (
            <Textarea
              value={prompt}
              onChange={(event) => setEdited(event.target.value)}
              spellCheck={false}
              aria-label="Fix prompt"
              className="min-h-[16rem] flex-1 resize-none p-3 font-mono text-[12px] leading-relaxed"
            />
          )}
        </div>

        <div className={cn(SECTION_WELL, 'min-h-0 shrink-0 space-y-4 lg:w-[22rem]')}>
          <Field label="Project" htmlFor={`${ids}-project`}>
            <Combobox
              id={`${ids}-project`}
              ariaLabel="Project"
              value={projectId}
              onChange={(next) => next && setProjectId(next)}
              options={projects.map(projectOption)}
              placeholder="Pick a project"
              searchPlaceholder="Search projects…"
              emptyText="No matching project."
            />
          </Field>

          <Field
            label="Run it in"
            hint={
              app
                ? undefined
                : 'The Deploy AI needs a monitor added from a Deploy app, which this one was not.'
            }
          >
            <Choices<Destination>
              label="Run it in"
              value={destination}
              onChange={setDestination}
              options={[
                { value: 'workspace', label: 'Workspace terminal' },
                { value: 'deploy', label: 'Deploy AI', disabled: !app },
              ]}
            />
          </Field>

          {destination === 'workspace' ? (
            <>
              <Field label="CLI" htmlFor={`${ids}-cli`}>
                <Combobox
                  id={`${ids}-cli`}
                  ariaLabel="CLI"
                  value={cliId ?? ''}
                  onChange={(next) => next && setPick({ cliId: next })}
                  options={cliOptions}
                  placeholder={choices.loading ? 'Looking for CLIs…' : 'No agent CLI installed'}
                  searchPlaceholder="Search CLIs…"
                  emptyText="No matching CLI."
                />
              </Field>
              <Field label="Model" htmlFor={`${ids}-model`}>
                <Combobox
                  id={`${ids}-model`}
                  ariaLabel="Model"
                  value={workspace?.model ?? ''}
                  onChange={(next) =>
                    workspace && setPick({ ...workspace, model: next.trim() || undefined })
                  }
                  options={(options?.models ?? []).map((one) => ({
                    value: one.value,
                    label: one.label,
                    keywords: [one.value],
                  }))}
                  placeholder={options?.modelFlag ? 'CLI default' : 'This CLI has no model flag'}
                  searchPlaceholder="Search or type a model name…"
                  emptyText="Type a model name to use it."
                  customLabel={(text) => `Use "${text}"`}
                  disabled={!options?.modelFlag}
                  allowCustom
                  clearable
                />
              </Field>
              {options && options.efforts.length > 0 ? (
                <Field label="Effort">
                  <EffortPicker
                    options={options}
                    model={workspace?.model}
                    value={workspace?.effort}
                    onChange={(effort) => workspace && setPick({ ...workspace, effort })}
                  />
                </Field>
              ) : null}
              <Field
                label="Permissions"
                htmlFor={`${ids}-mode`}
                hint={
                  mode
                    ? mode.description
                    : options?.modes.length
                      ? 'The mode set in Settings, or the CLI’s own when none is.'
                      : 'This CLI has no permission modes to pick from.'
                }
              >
                <Combobox
                  id={`${ids}-mode`}
                  ariaLabel="Permissions"
                  value={workspace?.mode ?? ''}
                  onChange={(next) =>
                    workspace && setPick({ ...workspace, mode: next || undefined })
                  }
                  options={(options?.modes ?? []).map((one) => ({
                    value: one.id,
                    label: one.risky ? `${one.label} (risky)` : one.label,
                  }))}
                  placeholder="Default"
                  searchPlaceholder="Search modes…"
                  emptyText="No matching mode."
                  disabled={!options?.modes.length}
                  clearable
                />
              </Field>
              {mode?.risky ? (
                <Notice tone="warning" size="sm">
                  The agent runs every command and edit without asking. Keep an eye on the tab.
                </Notice>
              ) : null}
            </>
          ) : (
            <>
              <Field label="AI" htmlFor={`${ids}-ai`}>
                <Combobox
                  id={`${ids}-ai`}
                  ariaLabel="AI"
                  value={aiCli ?? SETTINGS_PROVIDER}
                  onChange={(next) =>
                    setAi(
                      !next || next === SETTINGS_PROVIDER
                        ? SETTINGS_AI
                        : { cliId: next, modelId: null, effort: null },
                    )
                  }
                  options={[
                    { value: SETTINGS_PROVIDER, label: 'AI provider from Settings' },
                    ...promptClis.map((cli) => ({
                      value: cli.id,
                      label: cli.name,
                      icon: cliOptionIcon(cli.id),
                    })),
                  ]}
                  searchPlaceholder="Search…"
                  emptyText="No match."
                />
              </Field>
              {aiModels.length > 0 ? (
                <Field label="Model" htmlFor={`${ids}-ai-model`}>
                  <Combobox
                    id={`${ids}-ai-model`}
                    ariaLabel="Model"
                    value={aiModel?.id ?? ''}
                    onChange={(next) => {
                      const model = aiModels.find((one) => one.id === next);
                      setAi({
                        cliId: aiCli,
                        modelId: model?.id ?? null,
                        effort: model ? (defaultEffortFor(model) ?? null) : null,
                      });
                    }}
                    options={aiModels.map((one) => ({ value: one.id, label: one.label }))}
                    placeholder="CLI default"
                    searchPlaceholder="Search models…"
                    emptyText="No matching model."
                    clearable
                  />
                </Field>
              ) : null}
              {aiEffort && aiEfforts.length > 0 ? (
                <Field label="Effort">
                  <Choices<EffortLevel>
                    label="Effort"
                    value={aiEffort}
                    onChange={(effort) => setAi({ ...ai, cliId: aiCli, effort })}
                    options={aiEfforts.map((level) => ({
                      value: level,
                      label: EFFORT_LABELS[level],
                    }))}
                  />
                </Field>
              ) : null}
              <Field
                label="Commands on the server"
                hint="Changing it may ask for your password when the drawer opens."
              >
                <Choices
                  label="Commands on the server"
                  value={commandMode}
                  onChange={setCommandMode}
                  options={COMMAND_MODES}
                />
              </Field>
              {aiCli ? (
                <Field label="Project code" hint={project ? `In ${project.name}.` : undefined}>
                  <Choices<'read' | 'edit'>
                    label="Project code"
                    value={allowEdits ? 'edit' : 'read'}
                    onChange={(next) => setAllowEdits(next === 'edit')}
                    options={[
                      { value: 'read', label: 'Read only' },
                      { value: 'edit', label: 'Read and edit' },
                    ]}
                  />
                </Field>
              ) : null}
              {busy ? (
                <Notice tone="warning" size="sm">
                  The Deploy AI is busy on this server. Stop its run there first.
                </Notice>
              ) : null}
            </>
          )}
        </div>
      </div>

      <DialogFooter
        className={cn(FOOTER_HAIRLINE, 'flex-row items-center gap-2 px-5 py-3 sm:justify-between')}
      >
        <Button variant="ghost" size="sm" disabled={!ready} onClick={copyPrompt}>
          <Copy className="h-3.5 w-3.5" />
          Copy prompt
        </Button>
        {destination === 'workspace' ? (
          <div className="flex items-center gap-2">
            <SimpleTooltip label="Types the prompt in and leaves Enter to you">
              <Button
                variant="soft"
                size="sm"
                disabled={!ready || !project || !workspace}
                onClick={() => openInWorkspace(false)}
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                Open in Workspace
              </Button>
            </SimpleTooltip>
            <Button
              size="sm"
              disabled={!ready || !project || !workspace}
              onClick={() => openInWorkspace(true)}
            >
              <Run className="h-3.5 w-3.5" />
              Run in Workspace
            </Button>
          </div>
        ) : (
          <Button size="sm" disabled={!ready || !app || busy} onClick={openInDeploy}>
            <Robot className="h-3.5 w-3.5" />
            Open in Deploy AI
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
