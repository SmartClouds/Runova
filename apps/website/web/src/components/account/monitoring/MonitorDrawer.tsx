import { BellOff, Clock, Globe, ShieldCheck, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest, type Page } from '@/lib/account/api';
import {
  type CloudMonitor,
  duration,
  formatLatency,
  formatUptime,
  intervalChoices,
  intervalLabel,
  latestByRegion,
  type MonitorHour,
  type MonitorIncident,
  type MonitorSample,
  type ScopeUsage,
  verdictLabel,
} from '@/lib/account/monitoring';
import { cn } from '@/lib/utils';
import { AppCheckbox, AppSelect } from '../fields';
import { dateTime, Notice, relativeTime } from '../ui';
import { type ChartPoint, LatencyChart } from './charts';
import { hostOf, StatusDot, VerdictPill } from './MonitorCard';

/**
 * One monitor up close (E57): its response time over a day to three months, the newest result
 * from each region, its incidents, and its settings. A change is saved with the version it was
 * read at; a change made elsewhere in between asks for a reload rather than overwriting it. A
 * Viewer sees the settings read only, and can still mute it for themselves.
 */

const RANGES = [
  { key: '24h', label: '24 hours', days: 1 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];
const DAY_MS = 86_400_000;
const PROBLEM_STATES = new Set(['fail', 'unreachable', 'unauthorized', 'invalid']);

interface Settings {
  paused: boolean;
  intervalSec: number;
  notifyInApp: boolean;
  notifyTelegram: boolean;
}

function SettingRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-start gap-3 py-2.5',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      <AppCheckbox
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block font-medium text-sm">{label}</span>
        <span id={`${id}-hint`} className="block text-muted-foreground text-xs leading-relaxed">
          {description}
        </span>
      </span>
    </label>
  );
}

export function MonitorDrawer({
  monitor,
  scope,
  live,
  now,
  onClose,
  onSaved,
  onStale,
}: {
  monitor: CloudMonitor | null;
  scope: ScopeUsage | null;
  live: boolean;
  now: number;
  onClose: () => void;
  onSaved: (monitor: CloudMonitor) => void;
  /** Someone changed it elsewhere: read it again. */
  onStale: () => void;
}) {
  const ids = useId();
  const [range, setRange] = useState<RangeKey>('24h');
  const [samples, setSamples] = useState<MonitorSample[] | null>(null);
  const [hours, setHours] = useState<MonitorHour[] | null>(null);
  const [incidents, setIncidents] = useState<MonitorIncident[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const id = monitor?.id ?? null;
  const checked = monitor?.status.lastCheckedAt ?? null;
  const days = RANGES.find((one) => one.key === range)?.days ?? 1;

  // The day's samples and incidents follow each new result; the hours follow the range.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new check is the reason to read again
  useEffect(() => {
    if (id === null) return;
    let current = true;
    void Promise.all([
      apiRequest<{ items: MonitorSample[] }>(`/cloud-monitors/${id}/samples`),
      apiRequest<Page<MonitorIncident>>(`/cloud-monitors/${id}/incidents?pageSize=20`),
    ]).then(([sampleResponse, incidentResponse]) => {
      if (!current) return;
      if (sampleResponse.ok) setSamples(sampleResponse.value.items);
      if (incidentResponse.ok) setIncidents(incidentResponse.value.items);
    });
    return () => {
      current = false;
    };
  }, [id, checked]);

  useEffect(() => {
    if (id === null || range === '24h') return;
    let current = true;
    const from = new Date(Date.now() - days * DAY_MS).toISOString();
    void apiRequest<{ items: MonitorHour[] }>(
      `/cloud-monitors/${id}/hours?from=${encodeURIComponent(from)}`,
    ).then((response) => {
      if (current && response.ok) setHours(response.value.items);
    });
    return () => {
      current = false;
    };
  }, [id, range, days]);

  useEffect(() => {
    setProblem(null);
    setStale(false);
    if (id === null) {
      setSamples(null);
      setIncidents(null);
      setHours(null);
      setRange('24h');
    }
  }, [id]);

  const save = useCallback(
    async (patch: Partial<Settings>) => {
      if (!monitor) return;
      setSaving(true);
      setProblem(null);
      const response = await apiRequest<CloudMonitor>(`/cloud-monitors/${monitor.id}`, {
        method: 'PATCH',
        body: patch,
        ifMatch: `"${monitor.version}"`,
      });
      setSaving(false);
      if (response.ok) {
        onSaved(response.value);
        return;
      }
      if (response.problem.status === 412) {
        setStale(true);
        return;
      }
      setProblem(
        Object.values(response.problem.errors)[0]?.[0] ??
          response.problem.detail ??
          'The change could not be saved.',
      );
    },
    [monitor, onSaved],
  );

  const mute = useCallback(
    async (muted: boolean) => {
      if (!monitor) return;
      setSaving(true);
      const response = await apiRequest(`/cloud-monitors/${monitor.id}/mutes/me`, {
        method: muted ? 'PUT' : 'DELETE',
      });
      setSaving(false);
      if (response.ok) onSaved({ ...monitor, muted });
      else setProblem(response.problem.detail || 'That did not work.');
    },
    [monitor, onSaved],
  );

  const open = monitor !== null;
  const readOnly = monitor !== null && !monitor.canWrite;
  const from = now - days * DAY_MS;
  const points: ChartPoint[] =
    range === '24h'
      ? (samples ?? []).map((one) => ({
          at: Date.parse(one.at),
          value: one.latencyMs,
          failed: PROBLEM_STATES.has(one.state),
        }))
      : (hours ?? []).map((one) => ({
          at: Date.parse(one.hour),
          value: one.avgLatencyMs,
          failed: one.failures > 0,
        }));
  const regions = latestByRegion(samples ?? []);
  const floor = scope?.minIntervalSec ?? 300;
  const choices = intervalChoices(floor);
  if (monitor && !choices.some((one) => one.seconds === monitor.intervalSec)) {
    choices.unshift({ seconds: monitor.intervalSec, label: intervalLabel(monitor.intervalSec) });
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby={`${ids}-description`}
          className="app-glass fixed inset-y-2 right-2 z-50 flex w-[calc(100%-1rem)] max-w-xl flex-col overflow-hidden rounded-box shadow-2xl outline-none sm:inset-y-3 sm:right-3"
        >
          {monitor && (
            <>
              <header className="flex items-start gap-3 border-foreground/[0.08] border-b p-4 sm:p-5">
                <div className="pt-2">
                  <StatusDot verdict={monitor.status.verdict} live={live} />
                </div>
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="truncate font-display font-bold text-xl leading-tight tracking-tight">
                    {monitor.name}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description
                    id={`${ids}-description`}
                    className="mt-1 text-muted-foreground text-sm"
                  >
                    {monitor.projectName}
                    {monitor.environmentName ? ` · ${monitor.environmentName}` : ''}
                    {scope ? ` · ${scope.name}` : ''}
                  </DialogPrimitive.Description>
                  <p className="mt-1 truncate font-mono text-[0.72rem] text-muted-foreground">
                    {hostOf(monitor.url)}
                  </p>
                </div>
                <VerdictPill verdict={monitor.status.verdict} />
                <DialogPrimitive.Close asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close"
                    className="-mt-1 -mr-1 shrink-0"
                  >
                    <X />
                  </Button>
                </DialogPrimitive.Close>
              </header>

              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-5">
                {monitor.status.openIncident ? (
                  <Notice
                    tone="danger"
                    title={`Down for ${duration(monitor.status.openIncident.openedAt, null, now)}`}
                  >
                    <p>
                      {monitor.status.openIncident.problem ?? verdictLabel('down')}
                      {monitor.status.openIncident.region
                        ? `. Seen from ${monitor.status.openIncident.region}`
                        : ''}
                      {monitor.status.openIncident.confirmedFrom
                        ? ` and confirmed from ${monitor.status.openIncident.confirmedFrom}`
                        : ''}
                      .
                    </p>
                  </Notice>
                ) : null}

                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  {[
                    ['Latency', formatLatency(monitor.status.latencyMs)],
                    ['24 h uptime', formatUptime(monitor.status.uptime24h)],
                    ['Last check', checked ? relativeTime(checked, now) : 'Not yet'],
                    ['Every', intervalLabel(monitor.intervalSec)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground text-xs">{label}</dt>
                      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>

                <section aria-labelledby={`${ids}-chart`}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 id={`${ids}-chart`} className="font-semibold text-sm">
                      Response time
                    </h3>
                    <fieldset
                      aria-label="Range"
                      className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-1"
                    >
                      {RANGES.map((one) => (
                        <button
                          key={one.key}
                          type="button"
                          aria-pressed={range === one.key}
                          onClick={() => setRange(one.key)}
                          className={cn(
                            'cursor-pointer rounded-full px-2.5 py-1 font-medium text-xs transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            range === one.key
                              ? 'bg-primary/14 text-primary'
                              : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                          )}
                        >
                          {one.label}
                        </button>
                      ))}
                    </fieldset>
                  </div>
                  {(range === '24h' ? samples : hours) === null ? (
                    <div
                      aria-hidden
                      className="h-40 animate-pulse rounded-inner bg-foreground/[0.05] motion-reduce:animate-none"
                    />
                  ) : points.length === 0 ? (
                    <p className="rounded-inner bg-foreground/[0.03] px-3 py-6 text-center text-muted-foreground text-sm">
                      No checks in this range yet.
                    </p>
                  ) : (
                    <LatencyChart
                      points={points}
                      from={from}
                      to={now}
                      label={`Response time of ${monitor.name} over the last ${RANGES.find((one) => one.key === range)?.label}`}
                    />
                  )}
                </section>

                <section aria-labelledby={`${ids}-regions`}>
                  <h3
                    id={`${ids}-regions`}
                    className="mb-2 flex items-center gap-2 font-semibold text-sm"
                  >
                    <Globe aria-hidden className="size-4 text-muted-foreground" />
                    From each region
                  </h3>
                  {regions.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No result in the last day.</p>
                  ) : (
                    <ul className="divide-y divide-foreground/[0.07] rounded-inner bg-foreground/[0.03]">
                      {regions.map((one) => (
                        <li
                          key={one.region ?? 'unknown'}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                        >
                          <span className="min-w-24 font-medium font-mono text-xs">
                            {one.region ?? 'Unknown'}
                          </span>
                          <VerdictPill
                            verdict={
                              PROBLEM_STATES.has(one.state)
                                ? 'down'
                                : one.state === 'warn'
                                  ? 'degraded'
                                  : 'up'
                            }
                          />
                          <span className="tabular-nums">{formatLatency(one.latencyMs)}</span>
                          <span className="ml-auto text-muted-foreground text-xs">
                            {relativeTime(one.at, now)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section aria-labelledby={`${ids}-incidents`}>
                  <h3
                    id={`${ids}-incidents`}
                    className="mb-2 flex items-center gap-2 font-semibold text-sm"
                  >
                    <Clock aria-hidden className="size-4 text-muted-foreground" />
                    Incidents
                  </h3>
                  {incidents === null ? null : incidents.length === 0 ? (
                    <p className="flex items-center gap-2 text-muted-foreground text-sm">
                      <ShieldCheck aria-hidden className="size-4 text-success" />
                      No incidents yet.
                    </p>
                  ) : (
                    <ol className="space-y-2">
                      {incidents.map((one) => (
                        <li
                          key={one.id}
                          className="rounded-inner bg-foreground/[0.03] px-3 py-2.5 text-sm"
                        >
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-medium">{dateTime(one.openedAt)}</span>
                            <span className="text-muted-foreground">
                              {one.resolvedAt
                                ? `down for ${duration(one.openedAt, one.resolvedAt)}`
                                : 'still down'}
                            </span>
                          </div>
                          <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                            {one.problem ?? one.state}
                            {one.region ? ` · seen from ${one.region}` : ''}
                            {one.confirmedFrom ? `, confirmed from ${one.confirmedFrom}` : ''}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                <section aria-labelledby={`${ids}-settings`} className="space-y-2">
                  <h3 id={`${ids}-settings`} className="font-semibold text-sm">
                    Settings
                  </h3>
                  {readOnly && (
                    <Notice tone="info" title="You can look, not change">
                      <p>
                        You are a Viewer of {scope?.name ?? 'this team'}, so its monitors are read
                        only for you. Mute it for yourself below; ask an Owner, Admin or Member for
                        anything else.
                      </p>
                    </Notice>
                  )}
                  {monitor.suspendedReason === 'over-limit' && (
                    <Notice tone="warning" title="Paused by Runova">
                      <p>
                        The account type of {scope?.name ?? 'this scope'} allows fewer online
                        monitors than it had. Resume it once there is room.
                      </p>
                    </Notice>
                  )}
                  {stale && (
                    <Notice tone="warning" title="Changed somewhere else">
                      <p>
                        This monitor was changed since the page read it. Read it again, then make
                        your change.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        onClick={() => {
                          setStale(false);
                          onStale();
                        }}
                      >
                        Read it again
                      </Button>
                    </Notice>
                  )}
                  {problem && (
                    <Notice tone="danger" title="Not saved">
                      <p>{problem}</p>
                    </Notice>
                  )}
                  <div className="divide-y divide-foreground/[0.07]">
                    <SettingRow
                      id={`${ids}-paused`}
                      label="Paused"
                      description="A paused monitor is not checked and does not count toward the account type's limit."
                      checked={monitor.paused}
                      disabled={readOnly || saving}
                      onChange={(paused) => void save({ paused })}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                      <label htmlFor={`${ids}-interval`} className="min-w-0">
                        <span className="block font-medium text-sm">Check every</span>
                        <span className="block text-muted-foreground text-xs">
                          {scope?.accountTypeName
                            ? `${scope.accountTypeName} checks every ${intervalLabel(floor)} or slower.`
                            : 'As often as the account type allows.'}
                        </span>
                      </label>
                      <AppSelect
                        id={`${ids}-interval`}
                        size="sm"
                        value={String(monitor.intervalSec)}
                        disabled={readOnly || saving}
                        onChange={(event) => void save({ intervalSec: Number(event.target.value) })}
                      >
                        {choices.map((one) => (
                          <option key={one.seconds} value={one.seconds}>
                            {one.label}
                          </option>
                        ))}
                      </AppSelect>
                    </div>
                    <SettingRow
                      id={`${ids}-in-app`}
                      label="Alerts in the app and here"
                      description="Everyone who can see it hears when it goes down and comes back."
                      checked={monitor.notifyInApp}
                      disabled={readOnly || saving}
                      onChange={(notifyInApp) => void save({ notifyInApp })}
                    />
                    <SettingRow
                      id={`${ids}-telegram`}
                      label="Alerts on Telegram"
                      description="Sent through the RunovaHQ bot to everyone who linked a chat on the Notifications page."
                      checked={monitor.notifyTelegram}
                      disabled={readOnly || saving}
                      onChange={(notifyTelegram) => void save({ notifyTelegram })}
                    />
                    <SettingRow
                      id={`${ids}-mute`}
                      label="Mute for me"
                      description="You hear nothing about this monitor; the others still do."
                      checked={monitor.muted}
                      disabled={saving}
                      onChange={(muted) => void mute(muted)}
                    />
                  </div>
                  {monitor.muted ? (
                    <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      <BellOff aria-hidden className="size-3.5" />
                      Muted for you.
                    </p>
                  ) : null}
                </section>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
