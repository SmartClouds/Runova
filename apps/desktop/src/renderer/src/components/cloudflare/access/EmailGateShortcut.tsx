import { emailGateSummary } from '@shared/cloudflare/emailGate';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Lock, LockOpen, Monitor } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { cn } from '@/lib/utils';
import { EmailGateDialog } from './EmailGateDialog';
import { EMAIL_GATE_KEY, emailGateFindKey } from './parts';

/**
 * The email code gate on one name, as a small pill beside it on the core domain card or a site
 * (E96): on or off, a click to change it, and for the core domain a way to let this computer
 * through. Nothing shows when no connected Cloudflare zone holds the name. When the account is
 * not set up for email codes yet, the click goes to the zone's Access tab, where that happens.
 */
export function EmailGateShortcut({
  hostname,
  label,
  className,
}: {
  hostname: string;
  /** Words before the pill, shown only when the pill is. */
  label?: string;
  className?: string;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const found = useQuery({
    queryKey: emailGateFindKey(hostname),
    queryFn: () => window.runova.cloudflareEmailGate.find(hostname),
    retry: false,
  });
  const data = found.data;
  if (!data || data.host.gate.kind === 'elsewhere') return null;
  const { zone, host, readiness } = data;
  const on = host.gate.kind === 'on';
  const canChange = readiness.organization && readiness.oneTimePin && host.proxied;
  const noPass = on && host.role === 'core' && !host.thisComputerPass;

  async function letThrough(): Promise<void> {
    setBusy(true);
    try {
      await window.runova.cloudflareEmailGate.letThisComputerThrough({
        zoneId: zone.id,
        hostname: host.hostname,
      });
      toast.success(`This computer can reach ${host.hostname} again.`);
      await queryClient.invalidateQueries({ queryKey: EMAIL_GATE_KEY });
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <SimpleTooltip
        label={
          host.gate.kind === 'on'
            ? emailGateSummary(host.gate)
            : canChange
              ? 'Ask for an email code before it opens'
              : 'Set email codes up on the Cloudflare page'
        }
      >
        <button
          type="button"
          onClick={() =>
            canChange || on
              ? setOpen(true)
              : navigate(`/deploy?cloudflare=1&zone=${zone.id}&tab=access`)
          }
          className={cn(
            'inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
            on
              ? 'bg-success/12 text-success hover:bg-success/20'
              : 'bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/[0.1] hover:text-foreground',
          )}
        >
          {on ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
          {on ? 'Email code on' : 'Email code off'}
        </button>
      </SimpleTooltip>
      {noPass && (
        <Button
          type="button"
          size="sm"
          variant="soft"
          disabled={busy}
          onClick={() => void letThrough()}
        >
          <Monitor className="h-3.5 w-3.5" /> Let this computer through
        </Button>
      )}
      {open && <EmailGateDialog open zone={zone} host={host} onOpenChange={setOpen} />}
    </span>
  );
}
