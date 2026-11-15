import {
  accessDashboardUrl,
  emailGateSummary,
  validateTeamName,
} from '@shared/cloudflare/emailGate';
import { cloudflareErrorCode } from '@shared/cloudflareErrors';
import type { CloudflareZone, EmailGateHost, EmailGateReadiness } from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  Cloud,
  ExternalLink,
  Inbox,
  Lock,
  LockOpen,
  Monitor,
  Pencil,
  Shield,
  Spinner,
} from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { CloudflareCard, Problem } from '../fields';
import { GuidedFix } from '../server/GuidedFix';
import { EmailGateDialog } from './EmailGateDialog';
import { confirmTurnOff, EMAIL_GATE_KEY, roleChip } from './parts';

/** With more names than this, the card offers a search. */
const SEARCH_FROM = 9;

function ready(readiness: EmailGateReadiness): boolean {
  return readiness.organization && readiness.oneTimePin;
}

function NamesSkeleton(): React.JSX.Element {
  return (
    <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-8 w-8 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** The tile at the start of a row: closed and green when the gate is on. */
function StateTile({ host }: { host: EmailGateHost }): React.JSX.Element {
  const { gate } = host;
  const [Icon, tone] =
    gate.kind === 'on'
      ? [Lock, 'bg-success/12 text-success']
      : gate.kind === 'elsewhere'
        ? [Shield, 'bg-warning/12 text-warning']
        : host.proxied
          ? [LockOpen, 'bg-foreground/[0.06] text-muted-foreground']
          : [Cloud, 'bg-foreground/[0.04] text-muted-foreground/70'];
  return (
    <span
      aria-hidden
      className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-xl', tone)}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

function summary(host: EmailGateHost): string {
  const { gate } = host;
  if (gate.kind === 'on') return emailGateSummary(gate);
  if (gate.kind === 'elsewhere')
    return `${gate.name || 'An Access application'}, set up in Cloudflare`;
  if (!host.proxied) return "Cloudflare's proxy is off for it, so a gate cannot go on it yet";
  return 'Open to everyone';
}

function HostRow({
  host,
  cloudflareAccountId,
  canSwitch,
  busy,
  onTurnOn,
  onTurnOff,
  onEdit,
  onProxy,
  onLetThrough,
}: {
  host: EmailGateHost;
  cloudflareAccountId: string;
  canSwitch: boolean;
  busy: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onEdit: () => void;
  onProxy: () => void;
  onLetThrough: () => void;
}): React.JSX.Element {
  const { gate, hostname } = host;
  const on = gate.kind === 'on';
  const chip = roleChip(host);
  const noPass = on && host.role === 'core' && !host.thisComputerPass;
  return (
    <li aria-label={hostname} className="flex flex-wrap items-center gap-3 px-4 py-3">
      <StateTile host={host} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm text-foreground">{hostname}</span>
          {chip && <Chip tone={host.role === 'core' ? 'primary' : 'neutral'}>{chip}</Chip>}
        </div>
        <p className={cn('text-xs', on ? 'text-success' : 'text-muted-foreground')}>
          {summary(host)}
        </p>
        {noPass && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <Monitor className="h-3.5 w-3.5" aria-hidden />
              This computer has no pass, so the app takes another way to the core.
            </p>
            <Button type="button" size="sm" variant="soft" disabled={busy} onClick={onLetThrough}>
              Let this computer through
            </Button>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {busy && <Spinner className="h-3.5 w-3.5 text-muted-foreground" aria-label="Working" />}
        {on && (
          <>
            <SimpleTooltip label="Who can get a code">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit email code for ${hostname}`}
                disabled={busy}
                onClick={onEdit}
              >
                <Pencil />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Try it">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Open ${hostname}`}
                onClick={() => void window.runova.shell.openExternal(`https://${hostname}`)}
              >
                <ExternalLink />
              </Button>
            </SimpleTooltip>
          </>
        )}
        {gate.kind === 'off' && !host.proxied && host.recordId && (
          <Button type="button" size="sm" variant="soft" disabled={busy} onClick={onProxy}>
            <Cloud className="h-3.5 w-3.5" /> Turn on proxy
          </Button>
        )}
        {gate.kind === 'elsewhere' ? (
          <Button
            type="button"
            size="sm"
            variant="soft"
            onClick={() =>
              void window.runova.shell.openExternal(
                accessDashboardUrl(cloudflareAccountId, gate.appId),
              )
            }
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open in Cloudflare
          </Button>
        ) : (
          <Switch
            className="ml-1"
            aria-label={`Email code for ${hostname}`}
            checked={on}
            disabled={busy || (!on && (!canSwitch || !host.proxied))}
            onCheckedChange={(next) => (next ? onTurnOn() : onTurnOff())}
          />
        )}
      </div>
    </li>
  );
}

/**
 * Turns email codes on for the zone's Cloudflare account, once: Zero Trust with a team name when
 * the account has none, then the One-time PIN login.
 */
function SetupStep({
  zone,
  readiness,
}: {
  zone: CloudflareZone;
  readiness: EmailGateReadiness;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [teamName, setTeamName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nameId = useId();
  const needsTeam = !readiness.organization;
  const nameProblem = needsTeam && teamName ? validateTeamName(teamName) : null;

  async function turnOn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await window.runova.cloudflareEmailGate.prepare(
        needsTeam ? { zoneId: zone.id, teamName } : { zoneId: zone.id },
      );
      toast.success('Email codes are on for this Cloudflare account.');
      await queryClient.invalidateQueries({ queryKey: EMAIL_GATE_KEY });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn(FOOTER_HAIRLINE, 'space-y-3 bg-primary/[0.03] px-4 py-3.5')}>
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Inbox className="h-4 w-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            Turn on email codes for this Cloudflare account
          </p>
          <p className="text-xs text-muted-foreground">
            {needsTeam
              ? 'Codes come from Cloudflare Zero Trust, whose free plan covers small teams. Pick a team name for the sign-in page people see.'
              : 'One step turns on the One-time PIN login, so Cloudflare can mail codes. Nothing changes for any name until you turn its switch on.'}
          </p>
        </div>
      </div>
      <form
        className="flex flex-wrap items-end gap-2 pl-11"
        onSubmit={(event) => {
          event.preventDefault();
          void turnOn();
        }}
      >
        {needsTeam && (
          <div className="min-w-[14rem] flex-1 space-y-1">
            <Label htmlFor={nameId}>Team name</Label>
            <Input
              id={nameId}
              value={teamName}
              placeholder="acme"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameProblem ? true : undefined}
              onChange={(event) => setTeamName(event.target.value)}
            />
            <p
              className={cn('text-xs', nameProblem ? 'text-destructive' : 'text-muted-foreground')}
            >
              {nameProblem ??
                (teamName ? (
                  <span className="font-mono">{teamName}.cloudflareaccess.com</span>
                ) : (
                  'People see it in the address of the sign-in page.'
                ))}
            </p>
          </div>
        )}
        <Button
          type="submit"
          disabled={busy || (needsTeam && (!teamName || nameProblem !== null))}
          className={cn(needsTeam && 'mb-5')}
        >
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Turn on email codes
        </Button>
      </form>
      {error !== null && (
        <div className="pl-11">
          <GuidedFix error={error} onRetry={() => void turnOn()} retrying={busy} />
        </div>
      )}
    </div>
  );
}

/**
 * The zone's Access tab (E96): every name in it with a switch for the email code gate, Cloudflare
 * Access with a one-time PIN. A switch turned on opens the dialog that says who may get a code;
 * turned off it asks first. A name without Cloudflare's proxy offers to turn it on, a gate made
 * elsewhere is shown and left alone, and the core domain says whether this computer has its pass.
 */
export function EmailGateCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: queryKeys.cloudflareEmailGate(zone.id),
    queryFn: () => window.runova.cloudflareEmailGate.plan(zone.id),
  });
  const problem = useCloudflareError(plan.error);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<EmailGateHost | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  async function work(hostname: string, run: () => Promise<void>): Promise<void> {
    setBusy((current) => new Set(current).add(hostname));
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: EMAIL_GATE_KEY });
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(hostname);
        return next;
      });
    }
  }

  async function turnOff(host: EmailGateHost): Promise<void> {
    if (!(await confirmTurnOff(host))) return;
    await work(host.hostname, async () => {
      await window.runova.cloudflareEmailGate.remove({ zoneId: zone.id, hostname: host.hostname });
      toast.success(`${host.hostname} is open to everyone again.`);
    });
  }

  const target = (host: EmailGateHost) => ({ zoneId: zone.id, hostname: host.hostname });
  const hosts = plan.data?.hosts ?? [];
  const gated = hosts.filter((host) => host.gate.kind === 'on').length;
  const needle = search.trim().toLowerCase();
  const shown = hosts.filter(
    (host) =>
      !needle ||
      host.hostname.includes(needle) ||
      (roleChip(host) ?? '').toLowerCase().includes(needle),
  );

  let body: React.ReactNode;
  if (plan.isPending) {
    body = <NamesSkeleton />;
  } else if (plan.isError) {
    body = (
      <div className={cn(FOOTER_HAIRLINE, 'p-4')}>
        {cloudflareErrorCode(plan.error) === 'missing-permission' ? (
          <GuidedFix
            error={plan.error}
            onRetry={() => void plan.refetch()}
            retrying={plan.isFetching}
          />
        ) : (
          <Problem message={problem ?? ''} onRetry={() => void plan.refetch()} />
        )}
      </div>
    );
  } else if (hosts.length === 0) {
    body = (
      <EmptyState
        size="md"
        icon={Lock}
        title={`No names in ${zone.name} yet`}
        description="Add an A, AAAA or CNAME record on the DNS tab, with Cloudflare's proxy on, and it shows up here."
        className={FOOTER_HAIRLINE}
      />
    );
  } else {
    const readiness = plan.data.readiness;
    body = (
      <>
        {!ready(readiness) && <SetupStep zone={zone} readiness={readiness} />}
        {hosts.length >= SEARCH_FROM && (
          <div className={cn(FOOTER_HAIRLINE, 'px-4 py-2')}>
            <SearchPill
              type="search"
              label="Search names"
              clearLabel="Clear filter"
              placeholder="Search by name"
              value={search}
              onValueChange={setSearch}
            />
          </div>
        )}
        {shown.length === 0 ? (
          <p className={cn(FOOTER_HAIRLINE, 'px-4 py-6 text-center text-sm text-muted-foreground')}>
            No name matches that.
          </p>
        ) : (
          <ul aria-label={`Names in ${zone.name}`} className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
            {shown.map((host) => (
              <HostRow
                key={host.hostname}
                host={host}
                cloudflareAccountId={plan.data.cloudflareAccountId}
                canSwitch={ready(readiness)}
                busy={busy.has(host.hostname)}
                onTurnOn={() => setEditing(host)}
                onTurnOff={() => void turnOff(host)}
                onEdit={() => setEditing(host)}
                onProxy={() =>
                  void work(host.hostname, async () => {
                    await window.runova.cloudflareEmailGate.proxy(target(host));
                    await queryClient.invalidateQueries({
                      queryKey: queryKeys.cloudflareRecords(zone.id),
                    });
                    toast.success(`Cloudflare's proxy is on for ${host.hostname}.`);
                  })
                }
                onLetThrough={() =>
                  void work(host.hostname, async () => {
                    await window.runova.cloudflareEmailGate.letThisComputerThrough(target(host));
                    toast.success(`This computer can reach ${host.hostname} again.`);
                  })
                }
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <CloudflareCard
      icon={<Lock className="h-4 w-4" />}
      title="Email code"
      description={
        plan.data && hosts.length > 0
          ? gated === 0
            ? 'No name asks for an email code yet'
            : `${gated} of ${hosts.length} names ${gated === 1 ? 'asks' : 'ask'} for an email code`
          : 'Visitors type their email, Cloudflare mails them a code, and only people you list get in'
      }
    >
      {body}
      {editing && (
        <EmailGateDialog
          open
          zone={zone}
          host={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
    </CloudflareCard>
  );
}
