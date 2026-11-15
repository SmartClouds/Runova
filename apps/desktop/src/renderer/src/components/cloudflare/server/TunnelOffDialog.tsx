import type {
  CloudflareTunnelPreview,
  FirewallChangeSetInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useId, useState } from 'react';
import { Spinner } from '@/components/icons';
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
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { SegmentedChoice } from '../fields';
import { GuidedFix } from './GuidedFix';

/**
 * Turning the tunnel off. SSH opens to everyone again, and ports 80 and 443 either open to
 * everyone or stay for the IP lock to take over. cloudflared stops once that change is kept;
 * then the names point straight at the server again and the tunnel goes at Cloudflare.
 */

type After = 'open' | 'lock';

export function TunnelOffDialog({
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
  onApplied: (change: FirewallChangeSetInfo | undefined, pointBack: boolean) => void;
}): React.JSX.Element {
  const id = useId();
  const [after, setAfter] = useState<After>('open');
  const [pointBack, setPointBack] = useState(true);
  const [preview, setPreview] = useState<CloudflareTunnelPreview | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setApplyError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setPreview(null);
    setLoadError(null);
    window.runova.cloudflareTunnel
      .previewOff({ serverId, reopenWeb: after === 'open' })
      .then((result) => current && setPreview(result))
      .catch((error: unknown) => current && setLoadError(error));
    return () => {
      current = false;
    };
  }, [open, serverId, after]);

  async function apply(): Promise<void> {
    setBusy(true);
    setApplyError(null);
    try {
      const result = await window.runova.cloudflareTunnel.turnOff({
        serverId,
        reopenWeb: after === 'open',
      });
      onApplied(result.changeSet, pointBack);
    } catch (error) {
      setApplyError(error);
    } finally {
      setBusy(false);
    }
  }

  const commands = preview?.firewall?.commands ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Turn the tunnel off on {serverName}</DialogTitle>
          <DialogDescription>
            SSH opens to everyone again. cloudflared stops once you keep the firewall change, and
            the tunnel is then removed at Cloudflare.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <section className="space-y-1.5">
            <h4 id={`${id}-after`} className="text-xs font-medium text-muted-foreground">
              Ports 80 and 443 afterwards
            </h4>
            <SegmentedChoice
              labelledBy={`${id}-after`}
              layoutId={`${id}-after-pill`}
              options={[
                { value: 'open', label: 'Open to everyone' },
                { value: 'lock', label: 'Keep closed for the IP lock' },
              ]}
              value={after}
              disabled={busy}
              onChange={setAfter}
            />
            <p className="text-xs text-muted-foreground">
              {after === 'open'
                ? 'Anyone can reach the sites at the server address again.'
                : 'Turn the IP lock on next, or the sites stop answering until you do.'}
            </p>
          </section>
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${id}-back`}
              checked={pointBack}
              onCheckedChange={(checked) => setPointBack(checked === true)}
            />
            <Label htmlFor={`${id}-back`} className="text-sm font-normal leading-snug">
              Point the names straight at the server again (proxied through Cloudflare)
            </Label>
          </div>
          {loadError ? (
            <GuidedFix error={loadError} />
          ) : !preview ? (
            <Skeleton className="h-16 w-full" aria-busy="true" />
          ) : (
            <section aria-label="Firewall commands" className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">
                {commands.length === 0
                  ? 'Nothing in the firewall changes'
                  : `${commands.length} firewall commands`}
              </h4>
              {commands.length > 0 && (
                <pre className="max-h-40 overflow-auto rounded-xl bg-foreground/[0.03] p-2.5 font-mono text-xs ring-1 ring-inset ring-foreground/[0.08]">
                  {commands.join('\n')}
                </pre>
              )}
            </section>
          )}
          {applyError ? <GuidedFix error={applyError} /> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="soft" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy || !preview}
            onClick={() => void apply()}
          >
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            Turn off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
