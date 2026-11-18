import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, ChartColumn, SettingsIcon, Spinner } from '@/components/icons';
import { EmptyState, LoadFailure, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { SignInGate } from '../SignInGate';
import { hasRole } from '../security/format';
import { SECURITY_CARD } from '../security/SecurityCard';
import { useTrafficStatus } from './hooks';
import { TEXT } from './messages';
import { SecurityCard } from './SecurityCard';
import { TrafficReportView } from './TrafficReportView';
import { type SettingsTab, TrafficSettingsDialog } from './TrafficSettingsDialog';

const ALL = '*';

/**
 * A server's Traffic section (E109, E110), and the Traffic tab of one of its websites: how the
 * sites are used, read from the access logs nginx writes, and the attacks the server noticed in
 * them. Every role reads it; Admins turn statistics on and change the settings, block and unblock;
 * Owners decide whether the server blocks attackers by itself.
 */
export function TrafficPanel({
  server,
  siteId,
  onSiteChange,
  focusSecurity = false,
  onOpenSection,
  onUpdateCore,
}: {
  server: DeployServer;
  /** The site shown, or null for every site. */
  siteId: string | null;
  /** Shows the site picker; the site's own tab leaves it out, since its site is fixed. */
  onSiteChange?: (siteId: string | null) => void;
  /** Scrolls to the attacks, for an attack alert that opened the section. */
  focusSecurity?: boolean;
  /** On a site's tab: opens the server's Traffic section on this site. */
  onOpenSection?: () => void;
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const access = useQuery({
    queryKey: queryKeys.deployAccess(server.id),
    queryFn: () => window.runova.deploy.access(server.id),
    retry: false,
    staleTime: 30_000,
  });
  const signedIn = access.data?.state === 'signed-in';
  const status = useTrafficStatus(server.id);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [readExisting, setReadExisting] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  const roles = access.data?.user?.roles;
  const admin = hasRole(roles, 'admin');
  const owner = hasRole(roles, 'owner');
  const sites = status.data?.sites;
  const siteNames = useMemo(
    () => new Map((sites ?? []).map((site) => [site.siteId, site.domains[0] ?? site.siteId])),
    [sites],
  );
  const options = useMemo(
    () => [
      { value: ALL, label: TEXT.allSites },
      ...(sites ?? []).map((site) => ({
        value: site.siteId,
        label: site.domains[0] ?? site.siteId,
        keywords: site.domains,
      })),
    ],
    [sites],
  );

  if (access.isPending) {
    return (
      <div className={cn(SECURITY_CARD, 'space-y-3 p-4')} aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-full" />
      </div>
    );
  }
  if (!signedIn) return <SignInGate server={server} purpose="see how its websites are used" />;

  if (status.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-11 rounded-[calc(var(--radius)+2px)]" />
        <Skeleton className="h-72 rounded-[calc(var(--radius)+2px)]" />
      </div>
    );
  }
  if (status.isError) {
    const message = coreErrorMessage(status.error);
    return TEXT.olderCore.test(message) ? (
      <Notice
        tone="warning"
        action={
          onUpdateCore ? (
            <Button size="sm" onClick={onUpdateCore}>
              {TEXT.updateCore}
            </Button>
          ) : undefined
        }
      >
        {message}
      </Notice>
    ) : (
      <LoadFailure message={message} retry={() => void status.refetch()} />
    );
  }

  const current = status.data;
  const shownSite = siteId && siteNames.has(siteId) ? siteId : null;

  async function turnOn(): Promise<void> {
    setTurningOn(true);
    try {
      const result = await window.runova.deployTraffic.saveSettings({
        serverId: server.id,
        settings: { ...current.settings, enabled: true, readExistingLogs: readExisting },
      });
      if (result.problems.length > 0 || !result.status) {
        toast.error(result.problems.join(' '));
        return;
      }
      queryClient.setQueryData(queryKeys.deployTrafficStatus(server.id), result.status);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployTraffic(server.id) });
      toast.success(TEXT.turnedOn);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setTurningOn(false);
    }
  }

  const picker = onSiteChange ? (
    <Combobox
      ariaLabel="Website"
      options={options}
      value={shownSite ?? ALL}
      searchable={options.length > 7}
      searchPlaceholder="Search websites"
      className="h-7 w-56 text-xs"
      onChange={(value) => onSiteChange(value === ALL || value === '' ? null : value)}
    />
  ) : null;
  const trailing = (
    <>
      {onOpenSection && (
        <Button size="sm" variant="ghost" onClick={onOpenSection}>
          Open in Traffic <ArrowRight />
        </Button>
      )}
      <Button
        size="sm"
        variant="soft"
        aria-label="Traffic settings"
        onClick={() => setSettings('statistics')}
      >
        <SettingsIcon /> {TEXT.settings}
      </Button>
    </>
  );

  return (
    <div className="space-y-2">
      {current.settings.enabled ? (
        <TrafficReportView
          serverId={server.id}
          status={current}
          siteId={shownSite}
          admin={admin}
          siteNames={siteNames}
          leading={picker}
          trailing={trailing}
          focusSecurity={focusSecurity}
          onUpdateCore={onUpdateCore}
          onOpenDetection={() => setSettings('detection')}
        />
      ) : (
        <>
          <EmptyState
            card
            size="lg"
            icon={ChartColumn}
            title={TEXT.offTitle}
            description={
              <div className="mx-auto max-w-lg space-y-3">
                <p>{admin ? TEXT.offBodyAdmin : TEXT.offBodyViewer}</p>
                {admin && (
                  <span className="flex items-center justify-center gap-2 text-xs">
                    <Checkbox
                      id="traffic-turn-on-existing"
                      checked={readExisting}
                      onCheckedChange={(checked) => setReadExisting(checked === true)}
                    />
                    <Label htmlFor="traffic-turn-on-existing" className="text-xs font-normal">
                      {TEXT.readExisting}
                    </Label>
                  </span>
                )}
              </div>
            }
            action={
              admin ? (
                <Button disabled={turningOn} onClick={() => void turnOn()}>
                  {turningOn && <Spinner className="motion-safe:animate-spin" />}
                  {TEXT.turnOn}
                </Button>
              ) : undefined
            }
          />
          <div className="flex justify-end">{trailing}</div>
          <SecurityCard
            serverId={server.id}
            siteId={shownSite}
            admin={admin}
            detectionOn={current.attacks.enabled}
            timeZone={current.settings.timeZone || current.defaultTimeZone}
            siteNames={siteNames}
            onOpenSettings={() => setSettings('detection')}
          />
        </>
      )}
      {settings && (
        <TrafficSettingsDialog
          server={server}
          status={current}
          admin={admin}
          owner={owner}
          siteId={shownSite}
          initialTab={settings}
          onClose={() => setSettings(null)}
        />
      )}
    </div>
  );
}
