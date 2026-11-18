import { coreErrorMessage } from '@shared/coreErrors';
import type {
  AttackKind,
  AttackThresholds,
  TrafficStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { formatBytes } from '@shared/deploy/trafficFormat';
import { ATTACK_KINDS, TRAFFIC_LIMITS } from '@shared/deploy/trafficValidation';
import type { DeployTrafficSaveResult } from '@shared/deployTrafficTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Spinner, Trash2 } from '@/components/icons';
import { Notice, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { useProofStepUp } from '../overview/useProofStepUp';
import { GeolocationBlock } from './GeolocationBlock';
import { TEXT } from './messages';

export type SettingsTab = 'statistics' | 'detection' | 'autoBlock' | 'cloudflare';

const THRESHOLD_FIELDS: ReadonlyArray<{
  kind: AttackKind;
  fields: ReadonlyArray<{ key: keyof AttackThresholds; label: string }>;
}> = [
  {
    kind: 'scan',
    fields: [
      { key: 'scanProbes', label: 'Probe paths' },
      { key: 'scanNotFound', label: 'Not-found answers' },
      { key: 'scanWindowMinutes', label: 'Within minutes' },
    ],
  },
  {
    kind: 'bruteForce',
    fields: [
      { key: 'bruteForceAttempts', label: 'Login attempts' },
      { key: 'bruteForceWindowMinutes', label: 'Within minutes' },
    ],
  },
  { kind: 'flood', fields: [{ key: 'floodRequestsPerMinute', label: 'Requests a minute' }] },
  {
    kind: 'injection',
    fields: [
      { key: 'injectionHits', label: 'Probes' },
      { key: 'injectionWindowMinutes', label: 'Within minutes' },
    ],
  },
];

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones =
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ??
      [];
  } catch {
    zones = [];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

function NumberField({
  id,
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ''))}
        className="h-8"
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Problems({ problems }: { problems: string[] }): React.JSX.Element | null {
  if (problems.length === 0) return null;
  return (
    <Notice size="sm" tone="destructive" role="alert">
      <ul className="space-y-0.5">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </Notice>
  );
}

/**
 * Everything about traffic statistics and attack detection on a server, in four tabs: statistics
 * (on or off, countries, sites left out, how long figures are kept, the time zone, and deleting
 * them), detection (thresholds, the allowlist, how long attacks are kept), auto-block (an Owner's
 * call, with a step-up) and Cloudflare's visitor location. Admins change the first two; everyone
 * else reads them.
 */
export function TrafficSettingsDialog({
  server,
  status,
  admin,
  owner,
  siteId,
  initialTab = 'statistics',
  onClose,
}: {
  server: DeployServer;
  status: TrafficStatus;
  admin: boolean;
  owner: boolean;
  /** The site the report shows, offered when deleting statistics. */
  siteId: string | null;
  initialTab?: SettingsTab;
  onClose: () => void;
}): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const stepUp = useProofStepUp(server);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const [stats, setStats] = useState(() => ({
    enabled: status.settings.enabled,
    countries: status.settings.countries,
    excluded: new Set(status.settings.excludedSites),
    hourly: String(status.settings.hourlyRetentionDays),
    daily: String(status.settings.dailyRetentionDays),
    timeZone: status.settings.timeZone || status.defaultTimeZone,
    readExisting: false,
  }));
  const [detection, setDetection] = useState(() => ({
    enabled: status.attacks.enabled,
    thresholds: Object.fromEntries(
      Object.entries(status.attacks.thresholds).map(([key, value]) => [key, String(value)]),
    ) as Record<keyof AttackThresholds, string>,
    allowlist: status.attacks.allowlist.join('\n'),
    retention: String(status.attacks.eventRetentionDays),
  }));
  const [auto, setAuto] = useState(() => ({
    enabled: status.autoBlock.enabled,
    kinds: new Set<AttackKind>(status.autoBlock.kinds),
    minutes: String(status.autoBlock.minutes),
    maxBlocked: String(status.autoBlock.maxBlocked),
  }));
  const zones = useMemo(
    () =>
      timeZones(stats.timeZone).map((zone) => ({
        value: zone,
        label: zone === status.defaultTimeZone ? `${zone} (the server's)` : zone,
      })),
    [stats.timeZone, status.defaultTimeZone],
  );

  function settled(result: DeployTrafficSaveResult, done: string): boolean {
    if (result.problems.length > 0 || !result.status) {
      setProblems(result.problems);
      return false;
    }
    setProblems([]);
    queryClient.setQueryData(queryKeys.deployTrafficStatus(serverId), result.status);
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployTraffic(serverId) });
    toast.success(done);
    return true;
  }

  async function run(what: string, work: () => Promise<void>): Promise<void> {
    setBusy(what);
    try {
      await work();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const saveStatistics = () =>
    run('statistics', async () => {
      const result = await window.runova.deployTraffic.saveSettings({
        serverId,
        settings: {
          enabled: stats.enabled,
          countries: stats.countries,
          excludedSites: [...stats.excluded],
          hourlyRetentionDays: Number(stats.hourly),
          dailyRetentionDays: Number(stats.daily),
          timeZone: stats.timeZone,
          readExistingLogs: stats.enabled && !status.settings.enabled && stats.readExisting,
        },
      });
      settled(
        result,
        stats.enabled
          ? 'Traffic statistics saved.'
          : 'Traffic statistics are off. The figures so far are kept.',
      );
    });

  const saveDetection = () =>
    run('detection', async () => {
      const result = await window.runova.deployTraffic.saveAttackSettings({
        serverId,
        settings: {
          enabled: detection.enabled,
          thresholds: Object.fromEntries(
            Object.entries(detection.thresholds).map(([key, value]) => [key, Number(value)]),
          ) as unknown as AttackThresholds,
          allowlist: detection.allowlist
            .split(/[\s,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
          eventRetentionDays: Number(detection.retention),
        },
      });
      settled(result, detection.enabled ? 'Attack detection saved.' : 'Attack detection is off.');
    });

  const saveAutoBlock = () =>
    run('autoBlock', async () => {
      const result = await stepUp.run(
        (proof) =>
          window.runova.deployTraffic.saveAutoBlock({
            serverId,
            settings: {
              enabled: auto.enabled,
              kinds: ATTACK_KINDS.map((kind) => kind.value).filter((kind) => auto.kinds.has(kind)),
              minutes: Number(auto.minutes),
              maxBlocked: Number(auto.maxBlocked),
            },
            ...proof,
          }),
        'change auto-block',
      );
      if (!result) return;
      settled(result, auto.enabled ? 'Auto-block is on.' : 'Auto-block is off.');
    });

  async function deleteStatistics(scope: string | null): Promise<void> {
    const what = scope
      ? `the statistics of ${scope}`
      : `every website's statistics on ${server.nickname}`;
    const confirmed = await confirmDialog({
      title: `Delete ${what}?`,
      description:
        'Every hourly and daily figure goes, for every range. Statistics keep counting from now if they are on.',
      warning: 'Deleted statistics cannot be brought back.',
      confirmLabel: 'Delete statistics',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await run('delete', async () => {
      const next = await stepUp.run(
        (proof) => window.runova.deployTraffic.deleteData({ serverId, siteId: scope, ...proof }),
        'delete traffic statistics',
      );
      if (!next) return;
      queryClient.setQueryData(queryKeys.deployTrafficStatus(serverId), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployTraffic(serverId) });
      toast.success('Statistics deleted.');
    });
  }

  const readOnly = !admin;
  const loggingOff = status.sites.filter((site) => site.loggingOff);

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Traffic settings</DialogTitle>
            <DialogDescription>
              {admin
                ? `How ${server.nickname} counts its website traffic and watches for attacks.`
                : `How ${server.nickname} counts its website traffic. An Admin or Owner can change it.`}
            </DialogDescription>
          </DialogHeader>
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as SettingsTab);
              setProblems([]);
            }}
            className="min-w-0"
          >
            <TabsList aria-label="Traffic settings">
              <TabsTrigger value="statistics">Statistics</TabsTrigger>
              <TabsTrigger value="detection">Detection</TabsTrigger>
              <TabsTrigger value="autoBlock">Auto-block</TabsTrigger>
              <TabsTrigger value="cloudflare">Cloudflare</TabsTrigger>
            </TabsList>
            <div className="max-h-[60vh] overflow-y-auto pt-4 pr-1">
              <TabsContent value="statistics" className="mt-0 space-y-4">
                <label className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium">Count traffic</span>
                    <span className="block text-xs text-muted-foreground">
                      Off stops every read of the logs at once. The figures so far are kept.
                    </span>
                  </span>
                  <Switch
                    aria-label="Count traffic"
                    checked={stats.enabled}
                    disabled={readOnly}
                    onCheckedChange={(enabled) => setStats((s) => ({ ...s, enabled }))}
                  />
                </label>
                {stats.enabled && !status.settings.enabled && (
                  <span className="flex items-center gap-2 text-xs">
                    <Checkbox
                      id="traffic-read-existing"
                      checked={stats.readExisting}
                      disabled={readOnly}
                      onCheckedChange={(checked) =>
                        setStats((s) => ({ ...s, readExisting: checked === true }))
                      }
                    />
                    <Label htmlFor="traffic-read-existing" className="text-xs font-normal">
                      {TEXT.readExisting}
                    </Label>
                  </span>
                )}
                <label className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium">Countries</span>
                    <span className="block text-xs text-muted-foreground">
                      Where visitors are, from Cloudflare or from DB-IP's free country database.
                    </span>
                  </span>
                  <Switch
                    aria-label="Countries"
                    checked={stats.countries}
                    disabled={readOnly}
                    onCheckedChange={(countries) => setStats((s) => ({ ...s, countries }))}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    id="traffic-hourly"
                    label="Keep hourly figures (days)"
                    value={stats.hourly}
                    disabled={readOnly}
                    hint={`${TRAFFIC_LIMITS.hourlyRetentionDays[0]} to ${TRAFFIC_LIMITS.hourlyRetentionDays[1]}`}
                    onChange={(hourly) => setStats((s) => ({ ...s, hourly }))}
                  />
                  <NumberField
                    id="traffic-daily"
                    label="Keep daily figures (days)"
                    value={stats.daily}
                    disabled={readOnly}
                    hint={`${TRAFFIC_LIMITS.dailyRetentionDays[0]} to ${TRAFFIC_LIMITS.dailyRetentionDays[1]}`}
                    onChange={(daily) => setStats((s) => ({ ...s, daily }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="traffic-time-zone" className="text-xs">
                    Days start at midnight in
                  </Label>
                  <Combobox
                    id="traffic-time-zone"
                    ariaLabel="Time zone"
                    options={zones}
                    value={stats.timeZone}
                    disabled={readOnly}
                    searchPlaceholder="Search time zones"
                    onChange={(timeZone) => setStats((s) => ({ ...s, timeZone }))}
                  />
                </div>
                {status.sites.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className={SECTION_HEADING}>Sites counted</h4>
                    <ul className="space-y-1">
                      {status.sites.map((site) => (
                        <li key={site.siteId} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            id={`traffic-site-${site.siteId}`}
                            checked={!stats.excluded.has(site.siteId)}
                            disabled={readOnly}
                            onCheckedChange={(checked) =>
                              setStats((s) => {
                                const excluded = new Set(s.excluded);
                                if (checked === true) excluded.delete(site.siteId);
                                else excluded.add(site.siteId);
                                return { ...s, excluded };
                              })
                            }
                          />
                          <Label
                            htmlFor={`traffic-site-${site.siteId}`}
                            className="font-mono text-[12px] font-normal"
                          >
                            {site.domains[0] ?? site.siteId}
                          </Label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {loggingOff.length > 0 && (
                  <Notice size="sm" tone="warning">
                    {loggingOff.map((site) => site.domains[0] ?? site.siteId).join(', ')}{' '}
                    {loggingOff.length === 1
                      ? 'has a snippet that turns'
                      : 'have snippets that turn'}{' '}
                    access_log off, so some of {loggingOff.length === 1 ? 'its' : 'their'} traffic
                    is not counted.
                  </Notice>
                )}
                <p className="text-[11px] text-muted-foreground">
                  The statistics take about {formatBytes(status.storageBytes)} on the server.{' '}
                  {status.geoDatabaseReady
                    ? 'The country database is ready.'
                    : (status.geoDatabaseProblem ?? 'The country database is not ready yet.')}
                </p>
                {tab === 'statistics' && <Problems problems={problems} />}
                {admin && (
                  <div className={SECTION_WELL}>
                    <h4 className={SECTION_HEADING}>Delete statistics</h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Removes the figures counted so far. It asks for your password first.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {siteId && (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy !== null}
                          onClick={() => void deleteStatistics(siteId)}
                        >
                          <Trash2 /> Delete this site's
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy !== null}
                        onClick={() => void deleteStatistics(null)}
                      >
                        <Trash2 /> Delete every site's
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="detection" className="mt-0 space-y-4">
                <label className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium">Watch for attacks</span>
                    <span className="block text-xs text-muted-foreground">
                      Works with statistics on or off. Attacks raise an alert in the app and on
                      Telegram.
                    </span>
                  </span>
                  <Switch
                    aria-label="Watch for attacks"
                    checked={detection.enabled}
                    disabled={readOnly}
                    onCheckedChange={(enabled) => setDetection((d) => ({ ...d, enabled }))}
                  />
                </label>
                {THRESHOLD_FIELDS.map((group) => {
                  const kind = ATTACK_KINDS.find((entry) => entry.value === group.kind);
                  return (
                    <fieldset key={group.kind} className="space-y-2">
                      <legend className="text-sm font-medium">{kind?.label}</legend>
                      <p className="text-[11px] text-muted-foreground">{kind?.hint}</p>
                      <div className="grid grid-cols-3 gap-3">
                        {group.fields.map((field) => (
                          <NumberField
                            key={field.key}
                            id={`traffic-${field.key}`}
                            label={field.label}
                            value={detection.thresholds[field.key]}
                            disabled={readOnly}
                            onChange={(value) =>
                              setDetection((d) => ({
                                ...d,
                                thresholds: { ...d.thresholds, [field.key]: value },
                              }))
                            }
                          />
                        ))}
                      </div>
                    </fieldset>
                  );
                })}
                <div className="space-y-1">
                  <Label htmlFor="traffic-allowlist" className="text-xs">
                    Never flag or block (one address or range a line)
                  </Label>
                  <Textarea
                    id="traffic-allowlist"
                    rows={3}
                    value={detection.allowlist}
                    disabled={readOnly}
                    placeholder={'203.0.113.7\n10.0.0.0/8'}
                    className="font-mono text-xs"
                    onChange={(event) =>
                      setDetection((d) => ({ ...d, allowlist: event.target.value }))
                    }
                  />
                </div>
                <NumberField
                  id="traffic-event-retention"
                  label="Keep attacks (days)"
                  value={detection.retention}
                  disabled={readOnly}
                  hint={`${TRAFFIC_LIMITS.eventRetentionDays[0]} to ${TRAFFIC_LIMITS.eventRetentionDays[1]}. Attacks keep the addresses, so they can be blocked.`}
                  onChange={(retention) => setDetection((d) => ({ ...d, retention }))}
                />
                {tab === 'detection' && <Problems problems={problems} />}
              </TabsContent>

              <TabsContent value="autoBlock" className="mt-0 space-y-4">
                {!owner && (
                  <Notice size="sm">
                    Only an Owner can change auto-block, after confirming their password.
                  </Notice>
                )}
                <label className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium">Block attackers by itself</span>
                    <span className="block text-xs text-muted-foreground">
                      The server blocks an address the moment it attacks, on every site. Your
                      allowlist and the address this app connects from are never blocked.
                    </span>
                  </span>
                  <Switch
                    aria-label="Block attackers by itself"
                    checked={auto.enabled}
                    disabled={!owner}
                    onCheckedChange={(enabled) => setAuto((a) => ({ ...a, enabled }))}
                  />
                </label>
                <fieldset className="space-y-1.5">
                  <legend className="text-xs">For these attacks</legend>
                  {ATTACK_KINDS.map((kind) => (
                    <span key={kind.value} className="flex items-center gap-2">
                      <Checkbox
                        id={`traffic-auto-${kind.value}`}
                        checked={auto.kinds.has(kind.value)}
                        disabled={!owner}
                        onCheckedChange={(checked) =>
                          setAuto((a) => {
                            const kinds = new Set(a.kinds);
                            if (checked === true) kinds.add(kind.value);
                            else kinds.delete(kind.value);
                            return { ...a, kinds };
                          })
                        }
                      />
                      <Label htmlFor={`traffic-auto-${kind.value}`} className="text-sm font-normal">
                        {kind.label}
                      </Label>
                    </span>
                  ))}
                </fieldset>
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    id="traffic-auto-minutes"
                    label="Block for (minutes)"
                    value={auto.minutes}
                    disabled={!owner}
                    hint="0 blocks for good."
                    onChange={(minutes) => setAuto((a) => ({ ...a, minutes }))}
                  />
                  <NumberField
                    id="traffic-auto-max"
                    label="Most addresses blocked at once"
                    value={auto.maxBlocked}
                    disabled={!owner}
                    hint={`Up to ${TRAFFIC_LIMITS.maxBlocked[1]}.`}
                    onChange={(maxBlocked) => setAuto((a) => ({ ...a, maxBlocked }))}
                  />
                </div>
                {tab === 'autoBlock' && <Problems problems={problems} />}
              </TabsContent>

              <TabsContent value="cloudflare" className="mt-0">
                {tab === 'cloudflare' && <GeolocationBlock serverId={serverId} admin={admin} />}
              </TabsContent>
            </div>
          </Tabs>
          <DialogFooter>
            <Button variant="soft" onClick={onClose}>
              Close
            </Button>
            {tab === 'statistics' && admin && (
              <Button disabled={busy !== null} onClick={() => void saveStatistics()}>
                {busy === 'statistics' && <Spinner className="motion-safe:animate-spin" />}
                Save statistics
              </Button>
            )}
            {tab === 'detection' && admin && (
              <Button disabled={busy !== null} onClick={() => void saveDetection()}>
                {busy === 'detection' && <Spinner className="motion-safe:animate-spin" />}
                Save detection
              </Button>
            )}
            {tab === 'autoBlock' && owner && (
              <Button disabled={busy !== null} onClick={() => void saveAutoBlock()}>
                {busy === 'autoBlock' && <Spinner className="motion-safe:animate-spin" />}
                Save auto-block
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}
