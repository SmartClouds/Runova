/**
 * The Monitoring page's data (E57): the online monitors as the API sends them, grouped by scope,
 * project and environment; the line the header says; the live reducer for the hub's updates; and
 * the shapes the cards and the drawer draw. Shapes follow docs/website/api-contract.md.
 */

export type Verdict = 'up' | 'down' | 'degraded' | 'paused' | 'unknown';

export interface MonitorIncident {
  id: number;
  monitorId: number;
  openedAt: string;
  resolvedAt: string | null;
  state: string;
  problem: string | null;
  region: string | null;
  confirmedFrom: string | null;
}

export interface MonitorStatus {
  verdict: Verdict;
  state: string | null;
  lastCheckedAt: string | null;
  latencyMs: number | null;
  httpStatus: number | null;
  problem: string | null;
  region: string | null;
  confirming: boolean;
  openIncident: MonitorIncident | null;
  uptime24h: number | null;
}

export interface CloudMonitor {
  id: number;
  scopeId: number;
  itemId: string;
  name: string;
  projectName: string;
  environmentName: string | null;
  url: string;
  intervalSec: number;
  timeoutSec: number;
  authMode: string;
  hasSecret: boolean;
  secretChangedAt: string | null;
  allowInsecure: boolean;
  paused: boolean;
  suspendedReason: string | null;
  notifyInApp: boolean;
  notifyTelegram: boolean;
  muted: boolean;
  canWrite: boolean;
  status: MonitorStatus;
  createdAt: string;
  updatedAt: string;
  version: string;
}

export interface ScopeUsage {
  scopeId: number;
  kind: 'personal' | 'team';
  name: string;
  canWrite: boolean;
  accountTypeKey: string;
  accountTypeName: string;
  maxMonitors: number | null;
  minIntervalSec: number;
  historyDays: number;
  active: number;
  paused: number;
}

export interface MonitorHour {
  hour: string;
  checks: number;
  failures: number;
  warnings: number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
}

export interface MonitorSample {
  at: string;
  state: string;
  latencyMs: number | null;
  httpStatus: number | null;
  region: string | null;
  problem: string | null;
}

/** What the hub pushes after each result. */
export interface LiveUpdate {
  id: number;
  scopeId: number;
  itemId: string;
  paused: boolean;
  status: MonitorStatus;
}

export interface EnvironmentGroup {
  name: string | null;
  monitors: CloudMonitor[];
}

export interface ProjectGroup {
  name: string;
  environments: EnvironmentGroup[];
}

export interface ScopeGroup {
  scope: ScopeUsage;
  projects: ProjectGroup[];
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** The scope's own name first (Personal, then the teams as the usage lists them), then projects and environments by name. */
export function groupMonitors(monitors: CloudMonitor[], scopes: ScopeUsage[]): ScopeGroup[] {
  const known = new Map(scopes.map((one) => [one.scopeId, one]));
  const order = [...scopes.map((one) => one.scopeId)];
  for (const monitor of monitors) if (!order.includes(monitor.scopeId)) order.push(monitor.scopeId);

  const groups: ScopeGroup[] = [];
  for (const scopeId of order) {
    const mine = monitors.filter((one) => one.scopeId === scopeId);
    if (mine.length === 0) continue;
    const scope =
      known.get(scopeId) ??
      ({
        scopeId,
        kind: 'team',
        name: 'Shared with you',
        canWrite: mine.some((one) => one.canWrite),
        accountTypeKey: '',
        accountTypeName: '',
        maxMonitors: null,
        minIntervalSec: 300,
        historyDays: 0,
        active: mine.filter((one) => !one.paused).length,
        paused: mine.filter((one) => one.paused).length,
      } satisfies ScopeUsage);
    const projects = [...new Set(mine.map((one) => one.projectName))].sort(byName).map((name) => {
      const inProject = mine.filter((one) => one.projectName === name);
      const environments = [...new Set(inProject.map((one) => one.environmentName ?? ''))]
        .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : byName(a, b)))
        .map((environment) => ({
          name: environment === '' ? null : environment,
          monitors: inProject
            .filter((one) => (one.environmentName ?? '') === environment)
            .sort((a, b) => byName(a.name, b.name) || a.id - b.id),
        }));
      return { name, environments };
    });
    groups.push({ scope, projects });
  }
  return groups;
}

export type Tone = 'success' | 'danger' | 'warning' | 'neutral';

/** "All 12 monitors up", "2 down, 1 degraded", "No online monitors yet". */
export function overall(monitors: CloudMonitor[]): { text: string; tone: Tone } {
  if (monitors.length === 0) return { text: 'No online monitors yet', tone: 'neutral' };
  const count = (verdict: Verdict) =>
    monitors.filter((one) => one.status.verdict === verdict).length;
  const down = count('down');
  const degraded = count('degraded');
  const paused = monitors.filter((one) => one.paused).length;
  const waiting = monitors.filter((one) => !one.paused && one.status.verdict === 'unknown').length;
  if (down === 0 && degraded === 0 && paused === 0 && waiting === 0) {
    return {
      text: monitors.length === 1 ? 'The monitor is up' : `All ${monitors.length} monitors up`,
      tone: 'success',
    };
  }
  const parts: string[] = [];
  if (down > 0) parts.push(`${down} down`);
  if (degraded > 0) parts.push(`${degraded} degraded`);
  if (paused > 0) parts.push(`${paused} paused`);
  if (waiting > 0)
    parts.push(`${waiting} waiting for ${waiting === 1 ? 'its' : 'their'} first check`);
  return {
    text: parts.join(', '),
    tone: down > 0 ? 'danger' : degraded > 0 ? 'warning' : 'neutral',
  };
}

/** The hub's update applied to the list: only the monitor it names changes. */
export function applyLive(monitors: CloudMonitor[], update: LiveUpdate): CloudMonitor[] {
  const index = monitors.findIndex((one) => one.id === update.id);
  if (index === -1) return monitors;
  const next = [...monitors];
  next[index] = { ...monitors[index], paused: update.paused, status: update.status };
  return next;
}

const DAY_MS = 86_400_000;
const DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const PERCENT = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

export interface DayBar {
  start: number;
  checks: number;
  failures: number;
  warnings: number;
  tone: 'success' | 'warning' | 'danger' | 'none';
  /** What the bar says to a screen reader and in its tooltip. */
  label: string;
}

/** One bar per UTC day for the last `days` days, oldest first. */
export function dailyBars(hours: MonitorHour[], days: number, now = Date.now()): DayBar[] {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const bars: DayBar[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = today - i * DAY_MS;
    const inDay = hours.filter((one) => {
      const at = Date.parse(one.hour);
      return at >= start && at < start + DAY_MS;
    });
    const checks = inDay.reduce((sum, one) => sum + one.checks, 0);
    const failures = inDay.reduce((sum, one) => sum + one.failures, 0);
    const warnings = inDay.reduce((sum, one) => sum + one.warnings, 0);
    const tone =
      checks === 0 ? 'none' : failures > 0 ? 'danger' : warnings > 0 ? 'warning' : 'success';
    const day = DAY.format(start);
    const label =
      checks === 0
        ? `${day}: no checks`
        : `${day}: ${PERCENT.format(((checks - failures) / checks) * 100)}% up${
            failures > 0 ? `, ${failures} failed ${failures === 1 ? 'check' : 'checks'}` : ''
          }${warnings > 0 ? `, ${warnings} degraded` : ''}`;
    bars.push({ start, checks, failures, warnings, tone, label });
  }
  return bars;
}

/** The average latency of each hour, a gap where no check answered. */
export function latencyLine(hours: MonitorHour[]): { at: number; value: number | null }[] {
  return hours.map((one) => ({ at: Date.parse(one.hour), value: one.avgLatencyMs }));
}

/** The newest sample from each region, by region name. */
export function latestByRegion(samples: MonitorSample[]): MonitorSample[] {
  const newest = new Map<string, MonitorSample>();
  for (const sample of samples) {
    const key = sample.region ?? 'unknown';
    const known = newest.get(key);
    if (!known || Date.parse(sample.at) >= Date.parse(known.at)) newest.set(key, sample);
  }
  return [...newest.values()].sort((a, b) => byName(a.region ?? '', b.region ?? ''));
}

const VERDICTS: Record<Verdict, string> = {
  up: 'Up',
  down: 'Down',
  degraded: 'Degraded',
  paused: 'Paused',
  unknown: 'Waiting',
};

export function verdictLabel(verdict: Verdict): string {
  return VERDICTS[verdict];
}

export function verdictTone(verdict: Verdict): Tone {
  return verdict === 'up'
    ? 'success'
    : verdict === 'down'
      ? 'danger'
      : verdict === 'degraded'
        ? 'warning'
        : 'neutral';
}

/** "30 sec", "5 min", "1 hour", "1 day". */
export function intervalLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? '1 day' : `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? '1 hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} sec`;
}

const PRESETS = [30, 60, 300, 900, 3600, 21_600, 86_400];

/** The intervals the scope's type allows, from its floor up. */
export function intervalChoices(floorSec: number): { seconds: number; label: string }[] {
  return PRESETS.filter((seconds) => seconds >= floorSec).map((seconds) => ({
    seconds,
    label: intervalLabel(seconds),
  }));
}

export function formatLatency(ms: number | null): string {
  return ms === null ? 'No answer' : `${Math.round(ms)} ms`;
}

export function formatUptime(share: number | null): string {
  return share === null ? 'No checks yet' : `${PERCENT.format(share * 100)}%`;
}

/** How long something lasted: "3 min", "2 h 5 min", "1 day 4 h". */
export function duration(fromIso: string, toIso: string | null, now = Date.now()): string {
  const ms = Math.max(0, (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso));
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const daysCount = Math.floor(hours / 24);
  return hours % 24
    ? `${daysCount} ${daysCount === 1 ? 'day' : 'days'} ${hours % 24} h`
    : `${daysCount} ${daysCount === 1 ? 'day' : 'days'}`;
}
