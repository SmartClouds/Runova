import { CLI_REGISTRY } from '@runova/core';
import type { GithubRunnersResult, SshAgentMode, SshSavedServer } from '@shared/apiTypes';
import { runnerNameFrom, validateRunnerName } from '@shared/runnerName';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CliLogo } from '@/components/cliLogos';
import { ChevronDown, CircleAlert, Monitor, Robot, Server, Spinner } from '@/components/icons';
import { SSH_AGENT_MODES } from '@/components/terminal/sshAgentModes';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';
import { type SshAgentAiChoice, useSshAgentStore } from '@/stores/sshAgentStore';
import { launchRunnerInstall } from './runnerInstallLaunch';

/** The Combobox value for "the AI provider from Settings", which has no CLI id. */
const SETTINGS_PROVIDER = '__settings__';
const NO_SERVERS: SshSavedServer[] = [];

type Where = 'local' | 'ssh';

/** Every runner name already taken per repo, from whatever runner lists the page has loaded. */
function takenNamesByRepo(results: (GithubRunnersResult | undefined)[]): Map<string, string[]> {
  const taken = new Map<string, string[]>();
  for (const result of results) {
    if (!result?.ok) continue;
    for (const runner of result.runners) {
      if (runner.scope.kind !== 'repo') continue;
      const key = runner.scope.name.toLowerCase();
      taken.set(key, [...(taken.get(key) ?? []), runner.name]);
    }
  }
  return taken;
}

/** The server most recently connected to, which is most likely the one meant. */
function likeliestServer(servers: SshSavedServer[]): SshSavedServer | null {
  return (
    [...servers].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))[0] ?? null
  );
}

function WhereOption({
  pressed,
  disabled,
  icon,
  label,
  detail,
  onClick,
}: {
  pressed: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left ring-1 ring-inset transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        pressed
          ? 'bg-primary/10 ring-primary/50'
          : 'ring-foreground/[0.1] hover:bg-foreground/[0.04]',
      )}
    >
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5',
          pressed ? 'bg-primary/15 text-primary' : 'bg-foreground/[0.06] text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        <span className="truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

/**
 * Adds a GitHub self-hosted runner (E103). The only thing to look at is the name: where it goes,
 * the repo, the AI and how commands get approved all start from sensible defaults, tucked under
 * Details. The AI then installs it in a terminal tab where every command can be watched.
 */
export function AddRunnerDialog({
  open,
  onOpenChange,
  preferredRepo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The repo the page is looking at, picked when the projects have it. */
  preferredRepo?: string;
}): React.JSX.Element {
  const nameId = useId();
  const hintId = useId();
  const queryClient = useQueryClient();
  const lastMode = useSshAgentStore((s) => s.lastMode);
  const lastAi = useSshAgentStore((s) => s.lastAi);
  const defaultCliId = useCliStore((s) => s.defaultCliId);

  const [where, setWhere] = useState<Where>('local');
  const [serverId, setServerId] = useState('');
  const [name, setName] = useState('');
  /** Once the user types a name, picking another machine no longer replaces it. */
  const [nameTouched, setNameTouched] = useState(false);
  const [repo, setRepo] = useState('');
  const [cliValue, setCliValue] = useState<string | null>(null);
  const [mode, setMode] = useState<SshAgentMode>(lastMode);
  const [showDetails, setShowDetails] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const defaultsQuery = useQuery({
    queryKey: queryKeys.runnerInstallDefaults,
    queryFn: () => window.runova.pipelines.runnerDefaults(),
    enabled: open,
    meta: { silentLoading: true },
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.sshServers,
    queryFn: () => window.runova.ssh.listServers(),
    enabled: open,
    meta: { silentLoading: true },
  });
  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
    enabled: open,
    meta: { silentLoading: true },
  });

  const defaults = defaultsQuery.data;
  const servers = serversQuery.data ?? NO_SERVERS;
  const server = servers.find((s) => s.id === serverId) ?? null;
  const repos = useMemo(
    () => (defaults?.repos ?? []).map((entry) => `${entry.owner}/${entry.repo}`),
    [defaults],
  );

  // CLIs that can answer a one-shot prompt and are installed, as the terminal Ask AI offers.
  const promptClis = CLI_REGISTRY.filter(
    (cli) => cli.promptCommand && cliQuery.data?.find((c) => c.id === cli.id)?.installed,
  );

  // The name the chosen machine suggests: this computer's host name, or the server's nickname.
  const suggestedName =
    where === 'ssh' ? (server ? runnerNameFrom(server.nickname) : '') : (defaults?.name ?? '');

  useEffect(() => {
    if (!nameTouched) setName(suggestedName);
  }, [suggestedName, nameTouched]);

  // The repo the page points at when the projects have it, the first project's otherwise.
  useEffect(() => {
    if (repo && repos.includes(repo)) return;
    setRepo(preferredRepo && repos.includes(preferredRepo) ? preferredRepo : (repos[0] ?? ''));
  }, [repo, repos, preferredRepo]);

  // The AI the user picked last time, then the default CLI, then the first one installed, then
  // the provider from Settings when no CLI is around.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeded once, from what is known then
  useEffect(() => {
    if (cliValue !== null || !cliQuery.isFetched) return;
    const installed = (id: string | null | undefined): id is string =>
      !!id && promptClis.some((cli) => cli.id === id);
    if (lastAi && (lastAi.cliId === null || installed(lastAi.cliId))) {
      setCliValue(lastAi.cliId ?? SETTINGS_PROVIDER);
    } else if (installed(defaultCliId)) {
      setCliValue(defaultCliId);
    } else {
      setCliValue(promptClis[0]?.id ?? SETTINGS_PROVIDER);
    }
  }, [cliValue, cliQuery.isFetched, lastAi, defaultCliId]);

  // Start fresh each time it opens, so a name from last time does not linger.
  useEffect(() => {
    if (!open) return;
    setWhere('local');
    setNameTouched(false);
    setFailure(null);
    setShowDetails(false);
    setMode(useSshAgentStore.getState().lastMode);
  }, [open]);

  const runnerResults = queryClient
    .getQueriesData<GithubRunnersResult>({ queryKey: queryKeys.githubRunners })
    .map(([, data]) => data);
  const taken = takenNamesByRepo(runnerResults).get(repo.toLowerCase()) ?? [];
  const nameProblem = name ? validateRunnerName(name, taken) : null;
  const ready = defaultsQuery.isSuccess && cliValue !== null;
  const noRepo = defaultsQuery.isSuccess && repos.length === 0;
  const machineMissing = where === 'ssh' && !server;
  const canInstall =
    ready && !starting && !!repo && !machineMissing && validateRunnerName(name, taken) === null;

  function pickWhere(next: Where): void {
    setWhere(next);
    setFailure(null);
    if (next === 'ssh' && !server) setServerId(likeliestServer(servers)?.id ?? '');
  }

  function aiChoice(): SshAgentAiChoice {
    const cliId = cliValue === SETTINGS_PROVIDER ? null : cliValue;
    // The model and effort only carry over when they belong to this same CLI.
    if (lastAi && lastAi.cliId === cliId) return { ...lastAi };
    return { cliId, modelId: null, effort: null };
  }

  async function install(): Promise<void> {
    if (!canInstall) return;
    setStarting(true);
    setFailure(null);
    const runnerName = name.trim();
    try {
      await launchRunnerInstall(
        {
          where: where === 'ssh' && server ? { kind: 'ssh', server } : { kind: 'local' },
          name: runnerName,
          repo,
          mode,
          ai: aiChoice(),
        },
        {
          onInstalled: () => {
            toast.success(`Runner ${runnerName} is installed and running.`);
            void queryClient.invalidateQueries({ queryKey: queryKeys.githubRunners });
            void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
          },
        },
      );
      onOpenChange(false);
    } catch (error) {
      setFailure((error as Error).message || 'Could not start the install.');
    } finally {
      setStarting(false);
    }
  }

  const machineLabel =
    where === 'ssh'
      ? (server?.nickname ?? 'a saved server')
      : defaults
        ? `${defaults.osLabel}, ${defaults.arch}`
        : 'this computer';
  const aiLabel =
    cliValue === SETTINGS_PROVIDER
      ? 'AI provider from Settings'
      : (CLI_REGISTRY.find((cli) => cli.id === cliValue)?.name ?? '');
  const modeLabel = SSH_AGENT_MODES.find((option) => option.value === mode)?.label ?? '';
  const summary = [repo, aiLabel, modeLabel].filter(Boolean).join(' · ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          // The name is the one thing to look at, so it gets the focus with its text selected.
          event.preventDefault();
          nameRef.current?.focus();
          nameRef.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            Add a self-hosted runner
          </DialogTitle>
          <DialogDescription>
            The AI downloads a GitHub Actions runner, registers it and starts it as a service. You
            watch every command in a terminal tab.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void install();
          }}
        >
          <div role="group" aria-label="Where it runs" className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Where it runs</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <WhereOption
                pressed={where === 'local'}
                icon={<Monitor />}
                label="This computer"
                detail={
                  defaults ? `${defaults.osLabel}, ${defaults.arch}` : 'Reading this computer…'
                }
                onClick={() => pickWhere('local')}
              />
              <SimpleTooltip
                label={servers.length === 0 ? 'Save a server in Remote first.' : null}
                wrapTrigger
              >
                <WhereOption
                  pressed={where === 'ssh'}
                  disabled={servers.length === 0}
                  icon={<Server />}
                  label="A saved server"
                  detail={
                    servers.length === 0 ? 'None saved yet' : `${servers.length} saved, over SSH`
                  }
                  onClick={() => pickWhere('ssh')}
                />
              </SimpleTooltip>
            </div>
            {where === 'ssh' && servers.length > 1 ? (
              <Combobox
                className="h-8 text-xs"
                ariaLabel="Server"
                value={serverId}
                onChange={(id) => {
                  setServerId(id);
                  setFailure(null);
                }}
                searchPlaceholder="Search servers…"
                options={servers.map((s) => ({
                  value: s.id,
                  label: s.nickname,
                  hint: `${s.username}@${s.host}`,
                  icon: <Server className="h-3.5 w-3.5 shrink-0" />,
                }))}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId} className="text-xs">
              Runner name
            </Label>
            <Input
              ref={nameRef}
              id={nameId}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameTouched(true);
                setFailure(null);
              }}
              spellCheck={false}
              autoComplete="off"
              maxLength={80}
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={hintId}
              className="font-mono text-[13px]"
            />
            <p
              id={hintId}
              className={cn(
                'text-[11px]',
                nameProblem ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {nameProblem ??
                (where === 'ssh'
                  ? 'Named after the server. This is how GitHub lists it.'
                  : 'Named after this computer. This is how GitHub lists it.')}
            </p>
          </div>

          {noRepo ? (
            <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-warning/25">
              <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
              None of your projects has a GitHub repo, so there is nothing to register the runner on
              yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((value) => !value)}
                className="flex min-w-0 cursor-pointer items-center gap-1.5 self-start rounded-md py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown
                  className={cn(
                    'h-3 w-3 shrink-0 transition-transform duration-200',
                    showDetails ? 'rotate-0' : '-rotate-90',
                  )}
                />
                <span className="shrink-0 font-medium text-foreground">Details</span>
                <span className="min-w-0 truncate">{summary}</span>
              </button>

              {showDetails ? (
                <div className="flex flex-col gap-3 rounded-lg bg-foreground/[0.025] p-3 ring-1 ring-inset ring-foreground/[0.08]">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                      <Label className="text-xs">Repository</Label>
                      <Combobox
                        className="h-8 font-mono text-xs"
                        ariaLabel="Repository"
                        value={repo}
                        onChange={(value) => {
                          setRepo(value);
                          setFailure(null);
                        }}
                        searchPlaceholder="Search repos…"
                        options={(defaults?.repos ?? []).map((entry) => ({
                          value: `${entry.owner}/${entry.repo}`,
                          label: `${entry.owner}/${entry.repo}`,
                          hint: entry.projectName,
                        }))}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label className="text-xs">AI</Label>
                      <Combobox
                        className="h-8 text-xs"
                        ariaLabel="AI"
                        value={cliValue ?? ''}
                        onChange={setCliValue}
                        disabled={!cliQuery.isFetched}
                        searchable={false}
                        options={[
                          ...promptClis.map((cli) => ({
                            value: cli.id,
                            label: cli.name,
                            icon: <CliLogo cliId={cli.id} className="h-3.5 w-3.5 shrink-0" />,
                          })),
                          { value: SETTINGS_PROVIDER, label: 'AI provider (Settings)' },
                        ]}
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label className="text-xs">Approvals</Label>
                      <Combobox
                        className="h-8 text-xs"
                        ariaLabel="Approvals"
                        value={mode}
                        onChange={(value) => setMode(value as SshAgentMode)}
                        searchable={false}
                        options={SSH_AGENT_MODES.map((option) => ({
                          value: option.value,
                          label: option.label,
                        }))}
                      />
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {`Labels: self-hosted and the machine's OS and CPU (${machineLabel}). Runs as a service, so it comes back after a restart. Uses the newest runner release. The registration token never reaches the AI.`}
                  </p>
                </div>
              ) : null}
            </div>
          )}

          {failure ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-foreground ring-1 ring-inset ring-destructive/25"
            >
              <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-destructive" />
              {failure}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canInstall} aria-label="Install with AI">
              {starting ? (
                <>
                  <Spinner className="h-3.5 w-3.5 animate-spin" />
                  Getting things ready…
                </>
              ) : (
                <>
                  <Robot className="h-3.5 w-3.5" />
                  Install with AI
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
