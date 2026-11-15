import type { CloudflareTunnelPlan } from '@shared/cloudflareTypes';
import type { FirewallChangeSetInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useState } from 'react';
import { CircleInfo, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { GuidedFix } from './GuidedFix';

/**
 * Closing ports 80 and 443 once the tunnel is connected, on its own: after a setup that stopped
 * before this step, or when a rule opened them again. The exact commands first, then the change
 * set the countdown banner keeps.
 */
export function TunnelPortsDialog({
  open,
  serverId,
  serverName,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  serverId: string;
  serverName: string;
  onOpenChange: (open: boolean) => void;
  onApplied: (change: FirewallChangeSetInfo | undefined) => void;
}): React.JSX.Element {
  const [plan, setPlan] = useState<CloudflareTunnelPlan | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPlan(null);
    setLoadError(null);
    setApplyError(null);
    window.runova.cloudflareTunnel
      .plan(serverId)
      .then((result) => current && setPlan(result))
      .catch((error: unknown) => current && setLoadError(error));
    return () => {
      current = false;
    };
  }, [open, serverId]);

  async function apply(): Promise<void> {
    setBusy(true);
    setApplyError(null);
    try {
      const result = await window.runova.cloudflareTunnel.closePorts(serverId);
      onApplied(result.changeSet);
    } catch (error) {
      setApplyError(error);
    } finally {
      setBusy(false);
    }
  }

  const commands = plan?.ports.firewall?.commands ?? [];
  const unrouted = plan?.domains.filter((domain) => !domain.routed) ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Close ports 80 and 443 on {serverName}</DialogTitle>
          <DialogDescription>
            The tunnel is connected, so nothing needs these ports any more. Visitors keep coming in
            through Cloudflare.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {loadError ? (
            <GuidedFix error={loadError} />
          ) : !plan ? (
            <Skeleton className="h-20 w-full" aria-busy="true" />
          ) : (
            <>
              {unrouted.length > 0 && (
                <p className="text-xs text-warning">
                  Not pointing at the tunnel yet:{' '}
                  {unrouted.map((domain) => domain.domain).join(', ')}. They stop answering once the
                  ports close.
                </p>
              )}
              <h4 className="text-xs font-medium text-muted-foreground">
                {commands.length === 0
                  ? 'The firewall already matches'
                  : `${commands.length} firewall commands`}
              </h4>
              {commands.length > 0 && (
                <pre className="max-h-40 overflow-auto rounded-xl bg-foreground/[0.03] p-2.5 font-mono text-xs ring-1 ring-inset ring-foreground/[0.08]">
                  {commands.join('\n')}
                </pre>
              )}
              {plan.ports.notes.map((note) => (
                <p key={note} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <CircleInfo className="mt-0.5 h-3 w-3 shrink-0" /> {note}
                </p>
              ))}
            </>
          )}
          {applyError ? <GuidedFix error={applyError} /> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="soft" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !plan} onClick={() => void apply()}>
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            Close the ports
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
