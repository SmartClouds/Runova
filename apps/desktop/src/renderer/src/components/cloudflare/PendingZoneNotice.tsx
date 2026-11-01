import type { CloudflareZone } from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Clock, RefreshCw, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { Notice } from './fields';
import { NameServerList } from './NameServers';
import { GuidedFix } from './server/GuidedFix';

/**
 * Shown on a zone that waits for its registrar: the name servers to set there, ready to copy,
 * and a way to ask Cloudflare to look now rather than on its own schedule. Cloudflare allows
 * only a few checks an hour and says so when asked too often, which the page passes on.
 */
export function PendingZoneNotice({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function check(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await window.runova.cloudflare.checkActivation(zone.id);
      toast.success('Cloudflare is checking the name servers. This can take a few minutes.');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.cloudflareAccountZones(zone.accountId),
      });
    } catch (error) {
      cloudflareFailureText(error, queryClient);
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  const checkButton = (
    <Button type="button" size="sm" variant="soft" disabled={busy} onClick={() => void check()}>
      {busy ? (
        <>
          <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" /> Asking Cloudflare…
        </>
      ) : (
        <>
          <RefreshCw className="h-3.5 w-3.5" /> Check name servers now
        </>
      )}
    </Button>
  );

  return (
    <Notice tone="warning" icon={Clock}>
      <div className="min-w-0 flex-1 space-y-3">
        <p>
          Cloudflare is waiting for your registrar to use its name servers. Until then, changes here
          do not reach visitors. Set these where you bought the domain:
        </p>
        {zone.nameServers.length > 0 ? (
          <NameServerList servers={zone.nameServers} actions={checkButton} className="max-w-md" />
        ) : (
          checkButton
        )}
        {Boolean(failure) && <GuidedFix error={failure} />}
      </div>
    </Notice>
  );
}
