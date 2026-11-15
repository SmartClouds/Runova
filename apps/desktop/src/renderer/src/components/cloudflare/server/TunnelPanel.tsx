import { coreErrorMessage } from '@shared/coreErrors';
import type {
  CloudflareTunnelState,
  CloudflareTunnelStatus,
  FirewallChangeSetInfo,
  TunnelSshMode,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  Clock,
  Key,
  Lock,
  LockOpen,
  Power,
  Route,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { Notice } from '../fields';
import { TunnelOffDialog } from './TunnelOffDialog';
import { TunnelPortsDialog } from './TunnelPortsDialog';
import { TunnelSetupDialog } from './TunnelSetupDialog';
import { TunnelSshDialog } from './TunnelSshDialog';

/**
 * The Cloudflare Tunnel (E95), the other way the Cloudflare-only origin card keeps visitors from
 * going around Cloudflare: cloudflared on the server dials out, so ports 80 and 443 close to
 * everyone and no address list needs keeping up to date. The panel says how the tunnel stands in
 * one line, then the few facts that matter (its connections, who may open SSH, break-glass) and
 * the one next step. Each firewall step is a change set that the countdown banner above keeps.
 */

const STATE: Record<
  CloudflareTunnelState,
  { text: string; icon: typeof Lock; tone: string; spin?: boolean }
> = {
  off: { text: 'Off: no tunnel on this server', icon: LockOpen, tone: 'text-muted-foreground' },
  installing: {
    text: 'Setting up: installing cloudflared and connecting',
    icon: Spinner,
    tone: 'text-primary',
    spin: true,
  },
  connecting: {
    text: 'cloudflared is running and connecting to Cloudflare',
    icon: Clock,
    tone: 'text-warning',
  },
  portsOpen: {
    text: 'Connected, but ports 80 and 443 are still open to everyone',
    icon: Route,
    tone: 'text-warning',
  },
  pending: {
    text: 'Waiting for you to keep the firewall change',
    icon: Clock,
    tone: 'text-warning',
  },
  connected: {
    text: 'On: no open web ports, everything comes through the tunnel',
    icon: Lock,
    tone: 'text-success',
  },
  drifted: {
    text: 'On, but the firewall lets someone in again',
    icon: TriangleAlert,
    tone: 'text-destructive',
  },
  down: {
    text: 'Down: the tunnel lost its connection to Cloudflare',
    icon: TriangleAlert,
    tone: 'text-destructive',
  },
  failed: { text: 'Setting up the tunnel failed', icon: TriangleAlert, tone: 'text-destructive' },
};

export const SSH_MODE_LABELS: Record<TunnelSshMode, string> = {
  open: 'Open as the firewall has it',
  closed: 'Closed to everyone',
  cloudflare: 'Cloudflare only, through the tunnel',
  mesh: 'Cloudflare Mesh only',
};

const DELAYS = [15, 30, 60, 120, 240];

/** Servers whose tunnel was turned off here and still need their names and Cloudflare cleaned up. */
const cleanUps = new Map<string, boolean>();

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs font-medium text-foreground">
        {children}
      </dd>
    </div>
  );
}

export function TunnelPanel({
  serverId,
  serverName,
  signedIn,
  canAdmin,
  canOwn,
  busy,
  originLocked,
  onApplied,
}: {
  serverId: string;
  serverName: string;
  signedIn: boolean;
  canAdmin: boolean;
  /** Closing SSH to everyone and break-glass are the Owner's. */
  canOwn: boolean;
  busy: boolean;
  /** The IP lock is on; setting the tunnel up replaces it. */
  originLocked: boolean;
  onApplied: (change: FirewallChangeSetInfo) => void;
}): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const tunnel = useQuery({
    queryKey: queryKeys.cloudflareTunnel(serverId),
    queryFn: () => window.runova.cloudflareTunnel.status(serverId),
    enabled: signedIn,
    retry: false,
    refetchInterval: (query) => {
      const state = (query.state.data as CloudflareTunnelStatus | undefined)?.state;
      return state === 'installing' || state === 'connecting' || state === 'pending'
        ? 3_000
        : 60_000;
    },
  });
  const [dialog, setDialog] = useState<'setup' | 'ports' | 'ssh' | 'off' | null>(null);
  const [savingGlass, setSavingGlass] = useState(false);
  const status = tunnel.data;
  const state = status ? STATE[status.state] : null;
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareTunnel(serverId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.cloudflareOriginLock(serverId) });
  }, [queryClient, serverId]);
  const applied = (change: FirewallChangeSetInfo | undefined) => {
    setDialog(null);
    refresh();
    if (change) onApplied(change);
  };

  // Once the change that turns the tunnel off is kept, the names point back at the server and
  // the tunnel goes at Cloudflare.
  const offNow = status?.state === 'off';
  useEffect(() => {
    if (!offNow || !cleanUps.has(serverId)) return;
    const pointBack = cleanUps.get(serverId) ?? true;
    cleanUps.delete(serverId);
    window.runova.cloudflareTunnel
      .cleanUp(serverId, pointBack)
      .then((result) => {
        toast.success(
          result.skipped.length > 0
            ? `The tunnel is off. Left as they were: ${result.skipped.join(', ')}.`
            : 'The tunnel is off and removed at Cloudflare.',
        );
        refresh();
      })
      .catch((error: unknown) => toast.error(coreErrorMessage(error)));
  }, [offNow, serverId, refresh]);

  async function setBreakGlass(enabled: boolean, delayMinutes: number): Promise<void> {
    setSavingGlass(true);
    try {
      const next = await window.runova.cloudflareTunnel.breakGlass({
        serverId,
        enabled,
        delayMinutes,
      });
      queryClient.setQueryData(queryKeys.cloudflareTunnel(serverId), next);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setSavingGlass(false);
    }
  }

  if (tunnel.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (!status || !state) {
    return (
      <p className="text-sm text-muted-foreground">
        {tunnel.error ? coreErrorMessage(tunnel.error) : 'The tunnel could not be read.'}
      </p>
    );
  }

  const settled = !busy && status.state !== 'pending' && status.state !== 'installing';
  const on = status.enabled && status.state !== 'failed';

  return (
    <div className="space-y-3">
      <p className={cn('flex items-center gap-2 text-sm font-medium', state.tone)}>
        <state.icon className={cn('h-4 w-4 shrink-0', state.spin && 'motion-safe:animate-spin')} />
        {state.text}
      </p>
      {!status.enabled && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          cloudflared on the server dials out to Cloudflare, so the sites and the app's core domain
          answer through it and ports 80 and 443 close to everyone. You choose who may still open
          SSH.
          {originLocked &&
            ' Setting it up replaces the IP lock: its rules go when the tunnel closes the ports.'}
        </p>
      )}
      {on && (
        <dl className="settings-rows rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.08]">
          {status.tunnelName && <Fact label="Tunnel">{status.tunnelName}</Fact>}
          <Fact label="Connections to Cloudflare">
            {status.connections > 0 ? status.connections : 'None right now'}
          </Fact>
          <Fact label="SSH">{SSH_MODE_LABELS[status.sshMode]}</Fact>
          {status.sshHostname && <Fact label="SSH name">{status.sshHostname}</Fact>}
          {status.meshAddress && <Fact label="Mesh address">{status.meshAddress}</Fact>}
          {status.cloudflaredVersion && (
            <Fact label="cloudflared">{status.cloudflaredVersion}</Fact>
          )}
        </dl>
      )}
      {status.state === 'drifted' && status.openRules.length > 0 && (
        <Notice tone="destructive">
          <div className="space-y-1">
            <p className="text-xs font-medium">Still letting someone in</p>
            <ul className="font-mono text-xs leading-5">
              {status.openRules.slice(0, 4).map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
        </Notice>
      )}
      {status.lastError && (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {status.lastError}
        </p>
      )}
      {status.warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {warning}
        </p>
      ))}
      {on && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.08]">
          <div className="min-w-0 flex-1">
            <label htmlFor={`${id}-glass`} className="text-xs font-medium text-foreground">
              Reopen SSH if the tunnel stays down
            </label>
            <p className="text-xs text-muted-foreground">
              {status.breakGlassEnabled
                ? `After ${status.breakGlassDelayMinutes} minutes down, the server opens SSH to everyone and closes it again once the tunnel is back.`
                : "Off: if the tunnel fails with SSH closed, only your provider's console gets you in."}
            </p>
          </div>
          {status.breakGlassEnabled && (
            <select
              aria-label="Minutes before SSH reopens"
              className="h-7 rounded-full bg-foreground/[0.06] px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={status.breakGlassDelayMinutes}
              disabled={!canOwn || savingGlass}
              onChange={(event) => void setBreakGlass(true, Number(event.target.value))}
            >
              {[...new Set([...DELAYS, status.breakGlassDelayMinutes])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}
                  </option>
                ))}
            </select>
          )}
          <Switch
            id={`${id}-glass`}
            checked={status.breakGlassEnabled}
            disabled={!canOwn || savingGlass}
            onCheckedChange={(checked) =>
              void setBreakGlass(checked, status.breakGlassDelayMinutes)
            }
          />
        </div>
      )}
      {canAdmin && (
        <div className="flex flex-wrap gap-1.5">
          {(status.state === 'off' || status.state === 'failed') && (
            <Button size="sm" disabled={!settled} onClick={() => setDialog('setup')}>
              <Route className="h-3.5 w-3.5" />
              {status.state === 'failed' ? 'Try again' : 'Set up tunnel'}
            </Button>
          )}
          {(status.state === 'portsOpen' || status.state === 'drifted') && (
            <Button size="sm" disabled={!settled} onClick={() => setDialog('ports')}>
              <Lock className="h-3.5 w-3.5" /> Close ports 80 and 443
            </Button>
          )}
          {(status.state === 'connected' || status.state === 'drifted') && (
            <Button size="sm" variant="soft" disabled={!settled} onClick={() => setDialog('ssh')}>
              <Key className="h-3.5 w-3.5" /> Change SSH access
            </Button>
          )}
          {on && (
            <Button size="sm" variant="soft" disabled={!settled} onClick={() => setDialog('off')}>
              <Power className="h-3.5 w-3.5" /> Turn off
            </Button>
          )}
        </div>
      )}
      {status.state === 'connected' && status.sshMode === 'open' && canAdmin && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" />
          The sites are safe behind the tunnel. SSH is the one port left open; you can limit it with
          Change SSH access.
        </p>
      )}
      <TunnelSetupDialog
        open={dialog === 'setup'}
        serverId={serverId}
        serverName={serverName}
        onOpenChange={(open) => !open && setDialog(null)}
        onApplied={applied}
        onProgress={refresh}
      />
      <TunnelPortsDialog
        open={dialog === 'ports'}
        serverId={serverId}
        serverName={serverName}
        onOpenChange={(open) => !open && setDialog(null)}
        onApplied={applied}
      />
      <TunnelSshDialog
        open={dialog === 'ssh'}
        serverId={serverId}
        status={status}
        canOwn={canOwn}
        onOpenChange={(open) => !open && setDialog(null)}
        onApplied={applied}
        onProgress={refresh}
      />
      <TunnelOffDialog
        open={dialog === 'off'}
        serverId={serverId}
        serverName={serverName}
        onOpenChange={(open) => !open && setDialog(null)}
        onApplied={(change, pointBack) => {
          cleanUps.set(serverId, pointBack);
          applied(change);
        }}
      />
    </div>
  );
}
