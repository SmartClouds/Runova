import {
  buildLimitChips,
  getUsageProvider,
  type LimitChip,
  type ProviderUsage,
} from '@runova/core';
import type {
  ManageProviderUsage,
  ManageStatusBar,
  ManageSystemStats,
  ManageUsage,
} from '@runova/protocol';
import type { AccountStatus } from '../../../shared/accountTypes';
import type { GithubAccount, KeepAwakeStatus, SystemStatsSample } from '../../../shared/apiTypes';
import type { SyncOverview } from '../../../shared/syncTypes';
import type { ManageMethods } from './session';

/** What the status methods need from the rest of the app. */
export interface ManageStatusDeps {
  system(): Promise<SystemStatsSample>;
  usage(): Promise<ProviderUsage[]>;
  /** The same switches the desktop's status bar follows. */
  shownLimits(): Promise<Partial<Record<string, boolean>> | undefined>;
  now(): number;
  bar: ManageStatusBarDeps;
}

/** The rest of the desktop's status bar, as far as this process can answer with no window open. */
export interface ManageStatusBarDeps {
  agents(): { cliId: string | undefined; status: string | null }[];
  terminals(): Promise<number>;
  relays(): Promise<{ status: string; current: { phase: string } | null }[]>;
  transfers(): number;
  /** Null until the account runtime exists. */
  sync(): Promise<{ status: AccountStatus; overview: SyncOverview } | null>;
  github(): Promise<GithubAccount>;
  /** Null when Docker is not there. */
  docker(): Promise<{ state: string }[] | null>;
  /** Null when there is no Android SDK. */
  android(): Promise<{ state: string }[] | null>;
  keepAwake(): KeepAwakeStatus;
}

const HISTORY_DAYS = 30;

/** gh goes over the network, so it is asked as rarely as the desktop's own status bar asks it. */
const GITHUB_SIGNED_IN_MS = 5 * 60_000;
const GITHUB_SIGNED_OUT_MS = 15_000;
const GITHUB_FAILED_MS = 60_000;
/** Docker and adb each start a process, so a tick at the system's pace does not start another. */
const LOCAL_TOOL_MS = 10_000;

const LIVE_RELAYS = new Set(['running', 'paused', 'waiting']);
const BOOTING = new Set(['launching', 'connecting', 'booting', 'finishing']);

type BarGithub = ManageStatusBar['github'];

/** One read at a time, and none at all while the last answer is still fresh. */
function remembered<T>(
  now: () => number,
  freshFor: (value: T) => number,
  read: () => Promise<T>,
): () => Promise<T> {
  let held: { at: number; value: T } | null = null;
  let reading: Promise<T> | null = null;
  return () => {
    if (held && now() - held.at < freshFor(held.value)) return Promise.resolve(held.value);
    reading ??= read()
      .then((value) => {
        held = { at: now(), value };
        return value;
      })
      .finally(() => {
        reading = null;
      });
    return reading;
  };
}

/** A source that cannot answer drops out of the list; the rest of the bar still goes out. */
async function orNothing<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function githubReader(deps: ManageStatusBarDeps, now: () => number): () => Promise<BarGithub> {
  // What the desktop's bar keeps too: a failed check should not make a signed-in person look out.
  let known: string | null = null;
  const read = async (): Promise<BarGithub> => {
    const account = await deps.github();
    if (!account.cliAvailable) return null;
    if (account.authenticated && account.login) {
      known = account.login;
      return { login: account.login, signedIn: true, checkFailed: false };
    }
    if (account.checkFailed) return { login: known, signedIn: known !== null, checkFailed: true };
    known = null;
    return { login: null, signedIn: false, checkFailed: false };
  };
  const freshFor = (value: BarGithub): number => {
    if (value === null || (value.signedIn && !value.checkFailed)) return GITHUB_SIGNED_IN_MS;
    return value.checkFailed ? GITHUB_FAILED_MS : GITHUB_SIGNED_OUT_MS;
  };
  return remembered(now, freshFor, read);
}

function agentsOf(tabs: { cliId: string | undefined; status: string | null }[]) {
  const counts = { working: 0, waiting: 0, finished: 0, idle: 0 };
  for (const tab of tabs) {
    if (!tab.cliId || tab.status === 'exited') continue;
    if (tab.status === 'working') counts.working += 1;
    else if (tab.status === 'needs-input') counts.waiting += 1;
    else if (tab.status === 'done') counts.finished += 1;
    else counts.idle += 1;
  }
  return counts;
}

function relaysOf(runs: { status: string; current: { phase: string } | null }[]) {
  const counts = { running: 0, paused: 0, scheduled: 0, needsYou: 0 };
  for (const run of runs) {
    if (!LIVE_RELAYS.has(run.status)) continue;
    if (run.current?.phase === 'awaiting-user') counts.needsYou += 1;
    else if (run.status === 'running') counts.running += 1;
    else if (run.status === 'paused') counts.paused += 1;
    else counts.scheduled += 1;
  }
  return counts;
}

function syncOf(state: { status: AccountStatus; overview: SyncOverview } | null) {
  if (state?.status.state !== 'signed-in') return null;
  return {
    needsSignIn: state.status.needsSignIn,
    conflicts: state.overview.conflicts,
    phase: state.overview.phase,
    keysNeeded: state.overview.scopes.filter((scope) => scope.hasKey && !scope.unlockedHere).length,
  };
}

function limitOf(chip: LimitChip, now: number): ManageUsage['limits'][number] {
  return {
    providerId: chip.providerId,
    name: chip.name,
    plan: chip.plan,
    state: chip.state,
    problem: chip.problem,
    windows: chip.windows.map((window) => ({
      label: window.label,
      percent: window.percent,
      resetInMs: window.resetAt ? Date.parse(window.resetAt) - now : null,
    })),
  };
}

function providerOf(usage: ProviderUsage): ManageProviderUsage {
  return {
    providerId: usage.providerId,
    name: getUsageProvider(usage.providerId)?.name ?? usage.providerId,
    status: usage.status,
    error: usage.error ?? null,
    todayUsd: usage.today.costUsd,
    weekUsd: usage.last7d.costUsd,
    monthUsd: usage.last30d.costUsd,
    series: (usage.costSeries ?? usage.series ?? []).slice(-HISTORY_DAYS),
  };
}

export function statusMethods(deps: ManageStatusDeps): ManageMethods['calls'] {
  const fresh = () => LOCAL_TOOL_MS;
  const github = githubReader(deps.bar, deps.now);
  const docker = remembered(deps.now, fresh, () => deps.bar.docker());
  const android = remembered(deps.now, fresh, () => deps.bar.android());
  return {
    'status.bar': async (): Promise<ManageStatusBar> => {
      const [terminals, relays, sync, githubAccount, containers, emulators] = await Promise.all([
        orNothing(deps.bar.terminals),
        orNothing(deps.bar.relays),
        orNothing(deps.bar.sync),
        orNothing(github),
        orNothing(docker),
        orNothing(android),
      ]);
      const { mode, blocking, busy } = deps.bar.keepAwake();
      return {
        agents: agentsOf(deps.bar.agents()),
        terminals: terminals ?? 0,
        relays: relaysOf(relays ?? []),
        transfers: deps.bar.transfers(),
        sync: syncOf(sync),
        github: githubAccount,
        docker: containers && {
          running: containers.filter((container) => container.state === 'running').length,
          total: containers.length,
        },
        android: emulators && {
          running: emulators.filter((emulator) => emulator.state === 'running').length,
          booting: emulators.filter((emulator) => BOOTING.has(emulator.state)).length,
        },
        keepAwake: { mode, awake: blocking, busy },
      };
    },
    'status.system': async (): Promise<ManageSystemStats> => {
      const sample = await deps.system();
      return {
        cpuModel: sample.cpuModel,
        cpuCoreCount: sample.cpuCoreCount,
        cpuPercent: sample.cpuPercent,
        memPercent: sample.memPercent,
        memUsedBytes: sample.memUsedBytes,
        memTotalBytes: sample.memTotalBytes,
        netRxBytesPerSec: sample.netRxBytesPerSec,
        netTxBytesPerSec: sample.netTxBytesPerSec,
      };
    },
    'status.usage': async (): Promise<ManageUsage> => {
      const [usage, shown] = await Promise.all([deps.usage(), deps.shownLimits()]);
      const now = deps.now();
      return {
        limits: buildLimitChips(usage, shown).map((chip) => limitOf(chip, now)),
        providers: usage.map(providerOf),
      };
    },
  };
}
