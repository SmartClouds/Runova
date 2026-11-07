import { Activity, CircleAlert, CircleCheck, Download, Radio, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  applyLive,
  type CloudMonitor,
  groupMonitors,
  overall,
  type ScopeUsage,
} from '@/lib/account/monitoring';
import { cn } from '@/lib/utils';
import { Card, EmptyState, LoadFailure, PageHeader, Shimmer, useLoad } from '../ui';
import { connectMonitoringHub, type LiveState } from './live';
import { MonitorCard } from './MonitorCard';
import { MonitorDrawer } from './MonitorDrawer';

/**
 * The Monitoring page (E57): every online monitor the account can see, its own and its teams',
 * grouped by scope, project and environment, and live. Results arrive over the notifications hub;
 * while it is away the page reads the list every 30 seconds. Monitors are made in the app, where
 * the project's health endpoint lives.
 */

const POLL_MS = 30_000;

function LiveMark({ state }: { state: LiveState }) {
  const label =
    state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Updates every 30 s';
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-xs ring-1 ring-inset',
        state === 'live'
          ? 'bg-success/10 text-success ring-success/25'
          : 'bg-foreground/[0.05] text-muted-foreground ring-foreground/[0.1]',
      )}
    >
      <Radio
        aria-hidden
        className={cn('size-3.5', state === 'live' && 'motion-safe:animate-pulse')}
      />
      {label}
    </span>
  );
}

const SUMMARY_ICON = {
  success: CircleCheck,
  danger: CircleAlert,
  warning: TriangleAlert,
  neutral: Activity,
} as const;
const SUMMARY_TILE = {
  success: 'bg-success/12 text-success',
  danger: 'bg-destructive/12 text-destructive',
  warning: 'bg-warning/14 text-warning',
  neutral: 'bg-foreground/[0.06] text-foreground/80',
} as const;

export default function Monitoring() {
  const list = useLoad<{ items: CloudMonitor[] }>('/cloud-monitors');
  const usage = useLoad<{ scopes: ScopeUsage[] }>('/cloud-monitors/usage');
  const [monitors, setMonitors] = useState<CloudMonitor[] | null>(null);
  const [live, setLive] = useState<LiveState>('connecting');
  const [scopeFilter, setScopeFilter] = useState<number | 'all'>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { reload: reloadList } = list;
  const { reload: reloadUsage } = usage;

  useEffect(() => {
    if (list.value) setMonitors(list.value.items);
  }, [list.value]);

  const reload = useCallback(() => {
    void reloadList();
    void reloadUsage();
  }, [reloadList, reloadUsage]);

  useEffect(
    () =>
      connectMonitoringHub({
        updated: (update) =>
          setMonitors((current) => (current ? applyLive(current, update) : current)),
        changed: reload,
        state: setLive,
      }),
    [reload],
  );

  // The "2 min ago" labels move on their own; while the hub is away the list is read again too.
  useEffect(() => {
    const timer = setInterval(
      () => {
        setNow(Date.now());
        if (live !== 'live') reload();
      },
      live === 'live' ? 15_000 : POLL_MS,
    );
    return () => clearInterval(timer);
  }, [live, reload]);

  const scopes = usage.value?.scopes ?? [];
  const all = monitors ?? [];
  const groups = useMemo(() => groupMonitors(all, scopes), [all, scopes]);
  const shown =
    scopeFilter === 'all' ? groups : groups.filter((group) => group.scope.scopeId === scopeFilter);
  const shownMonitors = shown.flatMap((group) =>
    group.projects.flatMap((p) => p.environments.flatMap((e) => e.monitors)),
  );
  const summary = overall(shownMonitors);
  const SummaryIcon = SUMMARY_ICON[summary.tone];
  const opened = all.find((one) => one.id === openId) ?? null;
  const openedScope = opened
    ? (groups.find((group) => group.scope.scopeId === opened.scopeId)?.scope ?? null)
    : null;
  const regions = [
    ...new Set(
      shownMonitors.map((one) => one.status.region).filter((one): one is string => one !== null),
    ),
  ].sort();

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="Your online monitors and your teams', checked day and night by Runova Cloud."
        actions={
          // Wrapped, so the mark keeps its own width where the header stretches its actions.
          <div className="flex">
            <LiveMark state={live} />
          </div>
        }
      />

      {list.problem ? (
        <Card>
          <LoadFailure problem={list.problem} retry={reload} />
        </Card>
      ) : monitors === null ? (
        <Card className="p-5">
          <Shimmer lines={4} />
        </Card>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Activity />}
            title="No online monitors yet"
            action={
              <Button asChild>
                <a href="/download">
                  <Download />
                  Get the app
                </a>
              </Button>
            }
          >
            Monitors are made in the Runova app, where the project's health endpoint lives. Open
            Monitoring there, add or open a monitor and choose Runova Cloud under Where it runs.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-inner [&_svg]:size-5',
                  SUMMARY_TILE[summary.tone],
                )}
              >
                <SummaryIcon aria-hidden />
              </div>
              <div className="min-w-0">
                <p
                  className="font-display font-semibold text-lg leading-tight tracking-tight"
                  aria-live="polite"
                >
                  {summary.text}
                </p>
                <p className="mt-0.5 text-muted-foreground text-sm">
                  {regions.length > 0
                    ? `Checked from ${regions.join(', ')}`
                    : 'Waiting for the first checks'}
                </p>
              </div>
            </div>
            {groups.length > 1 && (
              <fieldset aria-label="Show" className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-1">
                {[
                  { id: 'all' as const, name: 'All' },
                  ...groups.map((group) => ({ id: group.scope.scopeId, name: group.scope.name })),
                ].map((one) => (
                  <button
                    key={one.id}
                    type="button"
                    aria-pressed={scopeFilter === one.id}
                    onClick={() => setScopeFilter(one.id)}
                    className={cn(
                      'cursor-pointer rounded-full px-3 py-1.5 font-medium text-sm transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      scopeFilter === one.id
                        ? 'bg-primary/14 text-primary'
                        : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                    )}
                  >
                    {one.name}
                  </button>
                ))}
              </fieldset>
            )}
          </Card>

          {shown.map((group) => (
            <section
              key={group.scope.scopeId}
              aria-labelledby={`scope-${group.scope.scopeId}`}
              className="space-y-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2
                  id={`scope-${group.scope.scopeId}`}
                  className="font-display font-semibold text-xl tracking-tight"
                >
                  {group.scope.name}
                </h2>
                {group.scope.accountTypeName ? (
                  <p className="text-muted-foreground text-sm">
                    {group.scope.accountTypeName} ·{' '}
                    {group.scope.maxMonitors === null
                      ? `${group.scope.active} online`
                      : `${group.scope.active} of ${group.scope.maxMonitors} online`}
                    {!group.scope.canWrite ? ' · you can view' : ''}
                  </p>
                ) : null}
              </div>
              {group.projects.map((project) => (
                <div key={project.name} className="space-y-3">
                  <h3 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
                    {project.name}
                  </h3>
                  {project.environments.map((environment) => (
                    <div key={environment.name ?? ''} className="space-y-2">
                      {environment.name ? (
                        <p className="text-muted-foreground text-xs">{environment.name}</p>
                      ) : null}
                      <div className="grid gap-3 md:grid-cols-2">
                        {environment.monitors.map((monitor) => (
                          <MonitorCard
                            key={monitor.id}
                            monitor={monitor}
                            live={live === 'live'}
                            now={now}
                            onOpen={setOpenId}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
      )}

      <MonitorDrawer
        monitor={opened}
        scope={openedScope}
        live={live === 'live'}
        now={now}
        onClose={() => setOpenId(null)}
        onSaved={(saved) => {
          setMonitors((current) =>
            current ? current.map((one) => (one.id === saved.id ? saved : one)) : current,
          );
          void reloadUsage();
        }}
        onStale={reload}
      />
    </>
  );
}
