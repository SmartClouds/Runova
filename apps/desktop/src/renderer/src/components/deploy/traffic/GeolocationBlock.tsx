import { cloudflareErrorMessage } from '@shared/cloudflareErrors';
import type { TrafficGeoSite } from '@shared/deployTrafficTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Cloud, Spinner } from '@/components/icons';
import { Chip, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';

function State({ label, on }: { label: string; on: boolean | null }): React.JSX.Element {
  return (
    <Chip tone={on === null ? 'neutral' : on ? 'success' : 'warning'} dot>
      {label}: {on === null ? 'unknown' : on ? 'on' : 'off'}
    </Chip>
  );
}

/**
 * Cloudflare's visitor location for the server's websites (E109 T3b). For a site whose domain is
 * on a Cloudflare zone this computer knows, it shows whether the zone adds the visitor's country (IP
 * Geolocation) and city and region (the visitor location headers), with a button that turns both
 * on. It goes to Cloudflare from this computer with the token kept here; the server never sees it.
 */
export function GeolocationBlock({
  serverId,
  admin,
}: {
  serverId: string;
  admin: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const query = useQuery({
    queryKey: queryKeys.deployTrafficGeolocation(serverId),
    queryFn: () => window.runova.deployTraffic.geolocation(serverId),
    retry: false,
    staleTime: 60_000,
  });

  async function turnOn(site: TrafficGeoSite): Promise<void> {
    if (!site.zoneId) return;
    setBusy(site.zoneId);
    try {
      const next = await window.runova.deployTraffic.turnOnGeolocation({
        serverId,
        zoneId: site.zoneId,
      });
      queryClient.setQueryData(queryKeys.deployTrafficGeolocation(serverId), next);
      toast.success(`Cloudflare now sends where visitors to ${site.zoneName} are.`);
    } catch (error) {
      toast.error(cloudflareErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Notice size="sm" tone="destructive">
        {cloudflareErrorMessage(query.error)}
      </Notice>
    );
  }
  const status = query.data;
  if (!status.connected) {
    return (
      <Notice size="sm">
        Connect a Cloudflare account in Cloudflare: domains and DNS to see whether your sites send
        where visitors are. Without it, countries come from DB-IP.
      </Notice>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A site behind Cloudflare gets its visitors' country from Cloudflare, which is more accurate
        than an address database. With the visitor location headers on as well, the report shows
        cities too.
      </p>
      <ul className="settings-rows" aria-label="Cloudflare visitor location by site">
        {status.sites.map((site) => (
          <li key={site.siteId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
            <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12px]">{site.domain}</span>
              <span className="block text-[11px] text-muted-foreground">
                {site.zoneName ? `Zone ${site.zoneName}` : 'Not on a Cloudflare zone you connected'}
              </span>
              {site.problem && (
                <span className="block text-[11px] text-destructive">{site.problem}</span>
              )}
            </span>
            {site.zoneId && (
              <>
                <State label="Country" on={site.ipGeolocation} />
                <State label="City and region" on={site.locationHeaders} />
                {admin && (site.ipGeolocation !== true || site.locationHeaders !== true) && (
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={busy !== null}
                    aria-label={`Turn on visitor location for ${site.domain}`}
                    onClick={() => void turnOn(site)}
                  >
                    {busy === site.zoneId && <Spinner className="motion-safe:animate-spin" />}
                    Turn on
                  </Button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
