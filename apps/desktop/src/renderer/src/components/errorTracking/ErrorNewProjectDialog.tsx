import {
  type Project,
  SENTRY_PLATFORMS,
  suggestSentryPlatform,
  validateSentryProjectName,
} from '@runova/core';
import type { ErrorConnectionSummary, ErrorCreatedProject } from '@shared/errorTrackingTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, Copy, ExternalLink, Key, Link, Plus, Spinner } from '@/components/icons';
import { Chip, Notice, SECTION_HEADING } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
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
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { copyText } from '../health/promptParts';
import { DsnField, ErrorSetupSnippets, OUT_LINK } from './ErrorDsnParts';
import { SCOPE_LIST_TEXT } from './errorView';
import { useErrorTeams } from './useErrorTracking';

/**
 * Making a Sentry project without leaving Runova (E47). The form asks for what Sentry needs (the
 * organization, a team and a name) and fills in what it can: the only organization and team, and
 * the name of the project it will be linked to. A token Runova knows cannot create projects is
 * stopped with a way to fix it, before anything is sent. Once Sentry has made the project, its DSN
 * comes back with the setup snippet for the platform, and the dialog stays on it until Done.
 */

const NO_LINK = '__none__';

const PLATFORM_OPTIONS = SENTRY_PLATFORMS.filter((one) => one.id !== 'other').map((one) => ({
  value: one.id,
  label: one.label,
}));

interface FormProps {
  connections: readonly ErrorConnectionSummary[];
  projects: readonly Project[];
  defaultProjectId?: string;
  onReplaceToken?: () => void;
  onBusyChange: (busy: boolean) => void;
  onCreated: (created: ErrorCreatedProject, platform: string | null) => void;
  onCancel: () => void;
}

function NewProjectForm({
  connections,
  projects,
  defaultProjectId,
  onReplaceToken,
  onBusyChange,
  onCreated,
  onCancel,
}: FormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const nameId = useId();
  const nameHintId = useId();
  const usable = connections.filter((one) => !one.locked);
  const [connectionId, setConnectionId] = useState(
    () => (usable.find((one) => one.canCreateProjects !== false) ?? usable[0])?.id ?? '',
  );
  const conn = usable.find((one) => one.id === connectionId) ?? null;
  const blocked = conn?.canCreateProjects === false;

  const startProject = projects.find((one) => one.id === defaultProjectId);
  const [linkTo, setLinkTo] = useState(startProject?.id ?? NO_LINK);
  const [name, setName] = useState(startProject?.name ?? '');
  const [nameEdited, setNameEdited] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [platform, setPlatform] = useState('');
  const [teamSlug, setTeamSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const teams = useErrorTeams(conn?.id ?? null, conn !== null && !blocked);
  const teamList = teams.data ?? [];

  // The first team (the token user's own come first) until the user picks another.
  useEffect(() => {
    if (!teams.data) return;
    if (!teams.data.some((one) => one.slug === teamSlug)) setTeamSlug(teams.data[0]?.slug ?? '');
  }, [teams.data, teamSlug]);

  const check = validateSentryProjectName(name);
  const showNameError = nameTouched && !check.ok;
  const ready = conn !== null && !blocked && check.ok && teamSlug !== '' && !busy;

  function changeLink(value: string): void {
    const next = value || NO_LINK;
    setLinkTo(next);
    const picked = projects.find((one) => one.id === next);
    if (picked && !nameEdited) setName(picked.name);
  }

  async function create(): Promise<void> {
    if (!ready || !conn || !check.ok) return;
    setBusy(true);
    onBusyChange(true);
    setProblem(null);
    try {
      const created = await window.runova.errorTracking.createProject({
        connectionId: conn.id,
        teamSlug,
        name: check.value,
        platform: platform || null,
        linkProjectId: linkTo === NO_LINK ? null : linkTo,
      });
      toast.success(`Created ${created.project.name} in Sentry`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.errorTracking });
      onCreated(created, platform || null);
    } catch (error) {
      setProblem(ipcErrorMessage(error, 'Could not create the project.'));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <DialogHeader className="px-5 py-4 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
        <DialogTitle className="text-base">New Sentry project</DialogTitle>
        <DialogDescription className="text-xs">
          {usable.length > 1
            ? 'Creates a project in the organization you pick and gives you its DSN, the address your app sends its errors to.'
            : `Creates a project in ${conn?.label ?? 'Sentry'} and gives you its DSN, the address your app sends its errors to.`}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {usable.length > 1 && (
          <div className="space-y-1.5">
            <p className={SECTION_HEADING}>Organization</p>
            <Combobox
              ariaLabel="Organization"
              value={connectionId}
              onChange={(value) => {
                if (!value) return;
                setConnectionId(value);
                setTeamSlug('');
                setProblem(null);
              }}
              options={usable.map((one) => ({
                value: one.id,
                label: one.label,
                hint: one.orgSlug,
              }))}
              searchPlaceholder="Search organizations…"
            />
          </div>
        )}

        {blocked ? (
          <Notice
            tone="warning"
            size="sm"
            icon={Key}
            action={
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => copyText(SCOPE_LIST_TEXT, 'Scopes')}
                >
                  <Copy />
                  Copy scopes
                </Button>
                {onReplaceToken && (
                  <Button type="button" size="xs" onClick={onReplaceToken}>
                    Replace token
                  </Button>
                )}
              </span>
            }
          >
            The token for {conn?.label} lacks the project:write scope, so it cannot create projects.
            Sentry cannot add a scope to a token, so make a new one with it and replace the old one.
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={nameId}>Project name</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
                setNameTouched(true);
              }}
              placeholder="storefront-api"
              spellCheck={false}
              autoComplete="off"
              maxLength={80}
              aria-invalid={showNameError}
              aria-describedby={nameHintId}
              disabled={blocked}
            />
            <p
              id={nameHintId}
              className={
                showNameError ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'
              }
            >
              {showNameError && !check.ok
                ? check.reason
                : 'Sentry makes the project slug from it, such as storefront-api.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <p className={SECTION_HEADING}>Team</p>
            {blocked ? (
              <Combobox
                ariaLabel="Team"
                value=""
                onChange={() => undefined}
                options={[]}
                disabled
              />
            ) : teams.isLoading ? (
              <Skeleton aria-label="Loading teams" className="h-9 w-full rounded-full" />
            ) : teams.isError ? (
              <p role="alert" className="text-xs text-destructive">
                Could not list the teams: {ipcErrorMessage(teams.error, 'Something went wrong.')}{' '}
                <button
                  type="button"
                  className="font-medium text-primary"
                  onClick={() => void teams.refetch()}
                >
                  Try again
                </button>
              </p>
            ) : teamList.length === 0 ? (
              <Notice tone="warning" size="sm">
                {conn?.label ?? 'The organization'} has no team the token can see. Create one in
                Sentry first; every project belongs to a team.
              </Notice>
            ) : (
              <Combobox
                ariaLabel="Team"
                value={teamSlug}
                onChange={(value) => value && setTeamSlug(value)}
                options={teamList.map((one) => ({
                  value: one.slug,
                  label: one.name,
                  hint: one.isMember === false ? 'not a member' : undefined,
                }))}
                searchPlaceholder="Search teams…"
                emptyText="No team matches."
              />
            )}
          </div>

          <div className="space-y-1.5">
            <p className={SECTION_HEADING}>Platform</p>
            <Combobox
              ariaLabel="Platform"
              value={platform}
              onChange={setPlatform}
              options={PLATFORM_OPTIONS}
              placeholder="Pick later"
              searchPlaceholder="Search platforms…"
              emptyText="No platform matches."
              clearable
              disabled={blocked}
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <p className={SECTION_HEADING}>Link to</p>
            <Combobox
              ariaLabel="Link to"
              value={linkTo}
              onChange={changeLink}
              options={[
                { value: NO_LINK, label: 'Do not link' },
                ...projects.map((one) => ({ value: one.id, label: one.name })),
              ]}
              searchPlaceholder="Search projects…"
              emptyText="No project matches."
              disabled={blocked}
            />
            <p className="text-[11px] text-muted-foreground">
              A linked project shows the new project’s errors on this tab.
            </p>
          </div>
        </div>

        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>

      <DialogFooter className="px-5 py-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready}>
          {busy ? <Spinner className="animate-spin" /> : <Plus />}
          Create project
        </Button>
      </DialogFooter>
    </form>
  );
}

function CreatedProject({
  created,
  platform,
  connection,
  projects,
  onDone,
}: {
  created: ErrorCreatedProject;
  platform: string | null;
  connection: ErrorConnectionSummary | undefined;
  projects: readonly Project[];
  onDone: () => void;
}): React.JSX.Element {
  const linked = created.link
    ? projects.find((one) => one.id === created.link?.projectId)
    : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="px-5 py-4 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
        <DialogTitle className="text-base">New Sentry project</DialogTitle>
        <DialogDescription className="text-xs">
          Put the DSN in your app and its errors show up here.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div role="status" aria-live="polite" className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/12 text-success">
            <CircleCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold tracking-tight">
              {created.project.name} is ready
            </h3>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-mono">
                {connection?.orgSlug ?? 'sentry'}/{created.project.slug}
              </span>
              {linked ? (
                <Chip tone="primary">
                  <Link />
                  Linked to {linked.name}
                </Chip>
              ) : (
                <span>Not linked to a project</span>
              )}
            </p>
          </div>
        </div>

        {created.dsn ? (
          <>
            <DsnField dsn={created.dsn} />
            <p className="-mt-3 text-[11px] text-muted-foreground">
              A DSN is public by design: it only lets an app send events, so it is fine in client
              code.
            </p>
            <ErrorSetupSnippets
              dsn={created.dsn}
              platformId={platform ?? suggestSentryPlatform(created.project.platform)}
              className="pt-1"
            />
          </>
        ) : (
          <Notice
            tone="warning"
            size="sm"
            action={
              <a href={created.keysUrl} target="_blank" rel="noreferrer" className={OUT_LINK}>
                <ExternalLink className="h-3 w-3" />
                Open keys in Sentry
              </a>
            }
          >
            Sentry made the project, but it has no client key yet, so there is no DSN to show. Add a
            key in Sentry, then use Get DSN here.
          </Notice>
        )}
      </div>

      <DialogFooter className="px-5 py-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
        <Button size="sm" variant="ghost" asChild>
          <a href={created.keysUrl} target="_blank" rel="noreferrer">
            <ExternalLink />
            Open in Sentry
          </a>
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ErrorNewProjectDialog({
  open,
  onOpenChange,
  connections,
  projects,
  defaultProjectId,
  onReplaceToken,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: readonly ErrorConnectionSummary[];
  projects: readonly Project[];
  /** The project to link to and name after, such as the one whose tab is open. */
  defaultProjectId?: string;
  /** Opens the connections, where a token that lacks project:write can be replaced. */
  onReplaceToken?: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    project: ErrorCreatedProject;
    platform: string | null;
  } | null>(null);

  function change(next: boolean): void {
    // Closing mid-create would hide whether the project was made.
    if (!next && busy) return;
    if (!next) setCreated(null);
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="flex max-h-[88vh] w-[min(42rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        {created ? (
          <CreatedProject
            created={created.project}
            platform={created.platform}
            connection={connections.find((one) => one.id === created.project.connectionId)}
            projects={projects}
            onDone={() => change(false)}
          />
        ) : (
          <NewProjectForm
            connections={connections}
            projects={projects}
            defaultProjectId={defaultProjectId}
            onReplaceToken={onReplaceToken}
            onBusyChange={setBusy}
            onCreated={(project, platform) => setCreated({ project, platform })}
            onCancel={() => change(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
