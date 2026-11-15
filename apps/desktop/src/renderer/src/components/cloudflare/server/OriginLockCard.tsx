import type { FirewallChangeSetInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { CloudflareMark } from '../CloudflareMark';
import { CardBody, CloudflareCard, SegmentedChoice } from '../fields';
import { IpLockPanel } from './IpLockPanel';
import { TunnelPanel } from './TunnelPanel';

/**
 * The Cloudflare-only origin card in a server's Firewall section: two ways to keep visitors from
 * going around Cloudflare to the server's own address, of which one is on at a time. The
 * Cloudflare Tunnel (E95) closes the web ports altogether and also decides who may open SSH; the
 * IP lock (E14 T6) keeps them open to Cloudflare's published addresses only. The choice shows the
 * one that is on, and otherwise the last one looked at here, the tunnel at first.
 */

type Mode = 'tunnel' | 'ips';

const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'tunnel', label: 'Cloudflare Tunnel' },
  { value: 'ips', label: 'Cloudflare IPs only' },
];

const HINTS: Record<Mode, string> = {
  tunnel: 'No open web ports: the server dials out to Cloudflare.',
  ips: "Ports 80 and 443 answer Cloudflare's addresses only.",
};

const STORAGE = 'runova:cloudflare-origin-mode:';

function remembered(serverId: string): Mode {
  try {
    return localStorage.getItem(STORAGE + serverId) === 'ips' ? 'ips' : 'tunnel';
  } catch {
    return 'tunnel';
  }
}

export function OriginLockCard({
  serverId,
  serverName,
  signedIn,
  canAdmin,
  canOwn = false,
  busy,
  onApplied,
}: {
  serverId: string;
  serverName: string;
  signedIn: boolean;
  canAdmin: boolean;
  /** Closing SSH to everyone and the tunnel's break-glass are the Owner's. */
  canOwn?: boolean;
  /** Another firewall change waits, or the link is reconnecting. */
  busy: boolean;
  onApplied: (change: FirewallChangeSetInfo) => void;
}): React.JSX.Element {
  const id = useId();
  const [picked, setPicked] = useState<Mode>(() => remembered(serverId));
  // The same queries the panels read, so these add no requests of their own.
  const tunnel = useQuery({
    queryKey: queryKeys.cloudflareTunnel(serverId),
    queryFn: () => window.runova.cloudflareTunnel.status(serverId),
    enabled: signedIn,
    retry: false,
  });
  const lock = useQuery({
    queryKey: queryKeys.cloudflareOriginLock(serverId),
    queryFn: () => window.runova.cloudflareServer.originLock(serverId),
    enabled: signedIn,
    retry: false,
  });
  const tunnelOn = tunnel.data?.enabled === true;
  const lockOn = lock.data?.enabled === true;

  // The one that is on wins over what was looked at last.
  useEffect(() => {
    if (tunnelOn) setPicked('tunnel');
    else if (lockOn) setPicked('ips');
  }, [tunnelOn, lockOn]);

  const choose = (next: Mode) => {
    setPicked(next);
    try {
      localStorage.setItem(STORAGE + serverId, next);
    } catch {
      // Only a convenience: the card still works without it.
    }
  };

  return (
    <CloudflareCard
      icon={<CloudflareMark />}
      title="Cloudflare-only origin"
      description="Stops visitors from going around Cloudflare to the server's own address."
    >
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p id={`${id}-mode`} className="text-xs font-medium text-foreground">
              How Cloudflare reaches this server
            </p>
            <p className="text-xs text-muted-foreground">{HINTS[picked]}</p>
          </div>
          <SegmentedChoice
            labelledBy={`${id}-mode`}
            layoutId={`${id}-mode-pill`}
            options={MODES}
            value={picked}
            disabled={false}
            onChange={choose}
          />
        </div>
        {picked === 'tunnel' ? (
          <TunnelPanel
            serverId={serverId}
            serverName={serverName}
            signedIn={signedIn}
            canAdmin={canAdmin}
            canOwn={canOwn}
            busy={busy}
            originLocked={lockOn}
            onApplied={onApplied}
          />
        ) : tunnelOn ? (
          <p className="text-sm text-muted-foreground">
            The Cloudflare Tunnel is on. Turn it off under Cloudflare Tunnel first, choosing to keep
            ports 80 and 443 closed for the IP lock, then lock them to Cloudflare here.
          </p>
        ) : (
          <IpLockPanel
            serverId={serverId}
            serverName={serverName}
            signedIn={signedIn}
            canAdmin={canAdmin}
            busy={busy}
            onApplied={onApplied}
          />
        )}
      </CardBody>
    </CloudflareCard>
  );
}
