import type { CloudflareTunnelDomain, CloudflareTunnelPlan } from '@shared/cloudflareTypes';
import type { FirewallChangeSetInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useId, useState } from 'react';
import { CircleCheck, CircleInfo, CircleX, Spinner, TriangleAlert } from '@/components/icons';
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
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { SegmentedChoice } from '../fields';
import { GuidedFix } from './GuidedFix';

/**
 * Setting the tunnel up, in one place: which Cloudflare account holds it, how each of the
 * server's names will answer, whether SSH gets a name on the tunnel, and the exact firewall
 * change. Starting runs four steps in order and shows each one as it goes: the tunnel is made and
 * cloudflared connects (nothing in the firewall has changed yet, so a failure here costs
 * nothing), the names are pointed at it, and only then do ports 80 and 443 close, as a change set
 * the countdown banner keeps.
 */

type StepId = 'create' | 'connect' | 'route' | 'close';
type StepState = 'waiting' | 'running' | 'done' | 'failed';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'create', label: 'Make the tunnel at Cloudflare and install cloudflared' },
  { id: 'connect', label: 'Wait for its first connection to Cloudflare' },
  { id: 'route', label: "Point the server's names at the tunnel" },
  { id: 'close', label: 'Close ports 80 and 443 to everyone' },
];

const CONNECT_TIMEOUT_MS = 180_000;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function DomainRow({
  domain,
  accountId,
}: {
  domain: CloudflareTunnelDomain;
  accountId: string | null;
}) {
  const inAccount = domain.zoneId !== null && domain.cloudflareAccountId === accountId;
  const role = domain.role === 'core' ? 'Core domain' : domain.role === 'ssh' ? 'SSH' : null;
  const text = inAccount
    ? domain.routed
      ? 'Already goes through the tunnel'
      : 'Will go through the tunnel'
    : domain.zoneId === null
      ? 'Not in a connected Cloudflare account: stops answering'
      : 'In another Cloudflare account: stops answering';
  const Icon = inAccount ? CircleCheck : TriangleAlert;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
      <span className="font-mono text-xs text-foreground">{domain.domain}</span>
      {role && (
        <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[11px] text-muted-foreground">
          {role}
        </span>
      )}
      <span
        className={cn(
          'flex items-center gap-1 text-xs',
          inAccount ? 'text-success' : 'text-warning',
        )}
      >
        <Icon className="h-3 w-3" /> {text}
      </span>
    </li>
  );
}

function StepRow({ label, state, detail }: { label: string; state: StepState; detail?: string }) {
  const icon =
    state === 'running' ? (
      <Spinner className="h-3.5 w-3.5 text-primary motion-safe:animate-spin" />
    ) : state === 'done' ? (
      <CircleCheck className="h-3.5 w-3.5 text-success" />
    ) : state === 'failed' ? (
      <CircleX className="h-3.5 w-3.5 text-destructive" />
    ) : (
      <span className="h-3.5 w-3.5 rounded-full ring-1 ring-inset ring-foreground/20" />
    );
  return (
    <li className="flex items-start gap-2.5 px-3 py-2">
      <span className="mt-0.5 flex shrink-0">{icon}</span>
      <div className="min-w-0">
        <p
          className={cn(
            'text-sm',
            state === 'waiting' ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {label}
        </p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
    </li>
  );
}

export function TunnelSetupDialog({
  open,
  serverId,
  serverName,
  onOpenChange,
  onApplied,
  onProgress,
}: {
  open: boolean;
  serverId: string;
  serverName: string;
  onOpenChange: (open: boolean) => void;
  onApplied: (change: FirewallChangeSetInfo | undefined) => void;
  /** Something changed on the server; the panel reads it again. */
  onProgress: () => void;
}): React.JSX.Element {
  const id = useId();
  const [plan, setPlan] = useState<CloudflareTunnelPlan | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [routeSsh, setRouteSsh] = useState(true);
  const [sshHostname, setSshHostname] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [steps, setSteps] = useState<Record<StepId, StepState> | null>(null);
  const [details, setDetails] = useState<Partial<Record<StepId, string>>>({});
  const [runError, setRunError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPlan(null);
    setLoadError(null);
    setSteps(null);
    setDetails({});
    setRunError(null);
    setUnderstood(false);
    window.runova.cloudflareTunnel
      .plan(serverId)
      .then((result) => {
        if (!current) return;
        setPlan(result);
        setAccountId(result.accounts[0]?.cloudflareAccountId ?? null);
        setSshHostname(result.suggestedSshHostname ?? '');
        setRouteSsh(result.suggestedSshHostname !== null);
      })
      .catch((error: unknown) => current && setLoadError(error));
    return () => {
      current = false;
    };
  }, [open, serverId]);

  const running = steps !== null && Object.values(steps).includes('running');
  const domains = plan?.domains.filter((domain) => domain.role !== 'ssh') ?? [];
  const lost = domains.filter(
    (domain) => domain.zoneId === null || domain.cloudflareAccountId !== accountId,
  );
  const directCore = plan?.coreDomain?.mode === 'direct';
  const hostname = sshHostname.trim().toLowerCase();
  const badHostname = routeSsh && !HOSTNAME.test(hostname);
  const commands = plan?.ports.firewall?.commands ?? [];
  const blocked =
    !plan ||
    plan.blocker !== null ||
    !accountId ||
    directCore ||
    badHostname ||
    (lost.length > 0 && !understood) ||
    running;

  async function start(): Promise<void> {
    const order: StepId[] = ['create', 'connect', 'route', 'close'];
    const from = steps ? (order.find((step) => steps[step] !== 'done') ?? 'create') : 'create';
    const state: Record<StepId, StepState> = steps ?? {
      create: 'waiting',
      connect: 'waiting',
      route: 'waiting',
      close: 'waiting',
    };
    let at: StepId = from;
    const mark = (step: StepId, next: StepState) => {
      state[step] = next;
      setSteps({ ...state });
    };
    setRunError(null);
    try {
      for (const step of order.slice(order.indexOf(from))) {
        at = step;
        mark(step, 'running');
        if (step === 'create') {
          await window.runova.cloudflareTunnel.setUp({
            serverId,
            cloudflareAccountId: accountId as string,
            sshHostname: routeSsh ? hostname : null,
          });
          onProgress();
        } else if (step === 'connect') {
          const deadline = Date.now() + CONNECT_TIMEOUT_MS;
          for (;;) {
            const status = await window.runova.cloudflareTunnel.status(serverId);
            if (status.state === 'failed')
              throw new Error(status.lastError ?? 'cloudflared did not connect.');
            if (
              status.connections > 0 &&
              status.state !== 'installing' &&
              status.state !== 'connecting'
            ) {
              setDetails((known) => ({
                ...known,
                connect: `${status.connections} connections to Cloudflare`,
              }));
              break;
            }
            if (Date.now() > deadline) {
              throw new Error(
                'cloudflared did not connect within three minutes. The server may not reach Cloudflare on port 7844.',
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }
          onProgress();
        } else if (step === 'route') {
          const routed = await window.runova.cloudflareTunnel.route(serverId);
          setDetails((known) => ({
            ...known,
            route:
              routed.skipped.length > 0
                ? `${routed.routed.length} routed; left alone: ${routed.skipped.join(', ')}`
                : `${routed.routed.length} routed`,
          }));
        } else {
          const result = await window.runova.cloudflareTunnel.closePorts(serverId);
          mark(step, 'done');
          onApplied(result.changeSet);
          return;
        }
        mark(step, 'done');
      }
    } catch (error) {
      mark(at, 'failed');
      setRunError(error);
    }
  }

  const accountOptions = plan?.accounts.map((account) => ({
    value: account.cloudflareAccountId,
    label: account.label,
  }));

  return (
    <Dialog open={open} onOpenChange={(next) => !running && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <div className="flex max-h-[calc(85vh-3rem)] min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Put {serverName} behind a Cloudflare Tunnel</DialogTitle>
            <DialogDescription>
              cloudflared on the server dials out to Cloudflare, so nothing needs to reach ports 80
              and 443 any more. The ports close only after the tunnel is connected and the names
              point at it.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
            {loadError ? (
              <GuidedFix error={loadError} />
            ) : !plan ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : steps ? (
              <ol
                aria-label="Progress"
                className="settings-rows rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.08]"
              >
                {STEPS.map((step) => (
                  <StepRow
                    key={step.id}
                    label={step.label}
                    state={steps[step.id]}
                    detail={details[step.id]}
                  />
                ))}
              </ol>
            ) : (
              <>
                {plan.blocker && (
                  <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    {plan.blocker}
                  </p>
                )}
                {plan.accounts.length === 0 ? (
                  <p role="alert" className="text-sm text-destructive">
                    No connected Cloudflare account holds a domain yet. Connect one on the
                    Cloudflare page first.
                  </p>
                ) : (
                  plan.accounts.length > 1 &&
                  accountOptions && (
                    <section className="space-y-1.5">
                      <h4
                        id={`${id}-account`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        Cloudflare account
                      </h4>
                      <SegmentedChoice
                        labelledBy={`${id}-account`}
                        layoutId={`${id}-account-pill`}
                        options={accountOptions}
                        value={accountId ?? accountOptions[0]?.value ?? ''}
                        disabled={false}
                        onChange={setAccountId}
                      />
                    </section>
                  )
                )}
                {domains.length > 0 && (
                  <section aria-label="Names on this server" className="space-y-1">
                    <h4 className="text-xs font-medium text-muted-foreground">
                      Names on this server
                    </h4>
                    <ul className="settings-rows rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.08]">
                      {domains.map((domain) => (
                        <DomainRow key={domain.domain} domain={domain} accountId={accountId} />
                      ))}
                    </ul>
                    {lost.length > 0 && (
                      <div className="flex items-start gap-2 pt-1">
                        <Checkbox
                          id={`${id}-lost`}
                          checked={understood}
                          onCheckedChange={(checked) => setUnderstood(checked === true)}
                        />
                        <Label
                          htmlFor={`${id}-lost`}
                          className="text-xs font-normal leading-snug text-warning"
                        >
                          I understand {lost.length === 1 ? 'this name stops' : 'these names stop'}{' '}
                          answering once the ports close. Add {lost.length === 1 ? 'it' : 'them'} to
                          this Cloudflare account to keep {lost.length === 1 ? 'it' : 'them'}.
                        </Label>
                      </div>
                    )}
                  </section>
                )}
                {directCore && (
                  <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    The core domain {plan.coreDomain?.domain} points straight at the server, and the
                    tunnel closes the ports it needs. Switch it to Through Cloudflare under
                    Security, Connection first.
                  </p>
                )}
                <section className="space-y-2 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.08]">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id={`${id}-ssh`}
                      checked={routeSsh}
                      onCheckedChange={(checked) => setRouteSsh(checked === true)}
                    />
                    <Label htmlFor={`${id}-ssh`} className="text-sm font-normal leading-snug">
                      Give SSH a name on the tunnel, behind Cloudflare Access
                      <span className="block text-xs text-muted-foreground">
                        Needed to close SSH's own port later and still get in from this app. Nothing
                        about SSH changes now.
                      </span>
                    </Label>
                  </div>
                  {routeSsh && (
                    <div className="space-y-1 pl-6">
                      <Label htmlFor={`${id}-host`} className="text-xs text-muted-foreground">
                        SSH name
                      </Label>
                      <Input
                        id={`${id}-host`}
                        value={sshHostname}
                        spellCheck={false}
                        autoCapitalize="off"
                        aria-invalid={badHostname}
                        onChange={(event) => setSshHostname(event.target.value)}
                        className="h-8 font-mono text-xs"
                      />
                      {badHostname && (
                        <p className="text-xs text-destructive">Use a name like ssh.example.com.</p>
                      )}
                    </div>
                  )}
                </section>
                <section aria-label="Firewall commands" className="space-y-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {commands.length === 0
                      ? 'Ports 80 and 443 are already closed'
                      : `Then, ${commands.length} firewall ${commands.length === 1 ? 'command' : 'commands'}`}
                  </h4>
                  {commands.length > 0 && (
                    <pre className="max-h-32 overflow-auto rounded-xl bg-foreground/[0.03] p-2.5 font-mono text-xs ring-1 ring-inset ring-foreground/[0.08]">
                      {commands.join('\n')}
                    </pre>
                  )}
                  {plan.ports.notes.map((note) => (
                    <p key={note} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <CircleInfo className="mt-0.5 h-3 w-3 shrink-0" /> {note}
                    </p>
                  ))}
                </section>
              </>
            )}
            {runError ? <GuidedFix error={runError} /> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              {steps && !running ? 'Close' : 'Cancel'}
            </Button>
            <Button type="button" disabled={blocked} onClick={() => void start()}>
              {running && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              {runError ? 'Try again' : 'Set up tunnel'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
