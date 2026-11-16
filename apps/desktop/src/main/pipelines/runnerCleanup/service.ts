import type {
  RunnerCleanupCleanRequest,
  RunnerCleanupCleanResult,
  RunnerCleanupItemOutcome,
  RunnerCleanupJobKind,
  RunnerCleanupOs,
  RunnerCleanupScanResult,
  RunnerCleanupScheduleResult,
  RunnerCleanupScheduleState,
  RunnerMachineLink,
} from '../../../shared/apiTypes';
import type { CleanStep } from './cleanSteps';
import type { MachineRun, RunOptions, ShellKind } from './machineShell';
import { planCleanup, type RegisteredRunners, scopeKey } from './plan';
import {
  posixCleanScript,
  posixInstallAnyScript,
  posixRemoveAnyScript,
  posixScanScript,
} from './posixScripts';
import { unsafeStep } from './safety';
import {
  parseCleanLine,
  parseGithubUrl,
  parseScanOutput,
  parseScheduleLine,
  type ScanStep,
  scanStepOf,
} from './scanParse';
import { normalizeSchedule, parseLastRun, readScheduleConfig } from './schedule';
import {
  windowsCleanScript,
  windowsInstallScript,
  windowsRemoveScript,
  windowsScanScript,
} from './windowsScripts';

/**
 * The runner cleanup's main-process side (E104): one operation at a time per machine, the last
 * scan per machine kept so a cleanup can only name items that scan reported, and the schedule
 * installed or removed on the machine itself.
 */

export interface RunnerCleanupServiceDeps {
  shell: {
    run: (
      link: RunnerMachineLink,
      build: (kind: ShellKind) => string,
      options: RunOptions,
    ) => Promise<MachineRun>;
  };
  /** The runners GitHub lists for a repo or an org, or null when GitHub could not say. */
  registeredRunners: (scope: {
    kind: 'repo' | 'org';
    name: string;
  }) => Promise<{ id: number; name: string }[] | null>;
  now: () => number;
  newId: () => string;
}

const SCAN_TIMEOUT_MS = 5 * 60_000;
const CLEAN_TIMEOUT_MS = 30 * 60_000;
const SCHEDULE_TIMEOUT_MS = 60_000;

export const NO_CRON =
  'This server has no crontab command. Install cron (sudo apt install cron, or sudo dnf install cronie) and try again.';

const NO_ANSWER = 'The machine stopped answering before this was done.';

interface HeldScan {
  scanId: string;
  steps: Map<string, CleanStep>;
  home: string;
  runnerDirs: string[];
}

export function machineKeyOf(link: RunnerMachineLink): string {
  return link.kind === 'local' ? 'local' : `ssh:${link.serverId}`;
}

function jobFor(os: RunnerCleanupOs | null, kind: ShellKind): RunnerCleanupJobKind {
  if (kind === 'windows' || os === 'windows') return 'task';
  return os === 'macos' ? 'launchd' : 'cron';
}

function lastAnswer(stdout: string) {
  let answer: ReturnType<typeof parseScheduleLine> = null;
  for (const text of stdout.split(/\r?\n/)) answer = parseScheduleLine(text) ?? answer;
  return answer;
}

export function createRunnerCleanupService(deps: RunnerCleanupServiceDeps) {
  const working = new Set<string>();
  const scans = new Map<string, HeldScan>();
  const aborts = new Map<string, AbortController>();

  async function exclusive<T extends { ok: boolean }>(
    link: RunnerMachineLink,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | { ok: false; reason: 'working'; error: string }> {
    const key = machineKeyOf(link);
    if (working.has(key)) {
      return {
        ok: false,
        reason: 'working',
        error: 'Runova is already scanning or cleaning this machine.',
      };
    }
    working.add(key);
    const abort = new AbortController();
    aborts.set(key, abort);
    try {
      return await work(abort.signal);
    } finally {
      working.delete(key);
      aborts.delete(key);
    }
  }

  async function registrations(scopes: { kind: 'repo' | 'org'; name: string }[]) {
    const unique = new Map(scopes.map((scope) => [scopeKey(scope), scope]));
    const found: RegisteredRunners = new Map();
    await Promise.all(
      [...unique].map(async ([key, scope]) => {
        try {
          found.set(key, await deps.registeredRunners(scope));
        } catch {
          found.set(key, null);
        }
      }),
    );
    return found;
  }

  function scan(
    link: RunnerMachineLink,
    onStep?: (step: ScanStep) => void,
  ): Promise<RunnerCleanupScanResult> {
    return exclusive(link, async (signal) => {
      const run = await deps.shell.run(
        link,
        (kind) => (kind === 'windows' ? windowsScanScript() : posixScanScript()),
        {
          timeoutMs: SCAN_TIMEOUT_MS,
          signal,
          onLine: (text) => {
            const step = scanStepOf(text);
            if (step) onStep?.(step);
          },
        },
      );
      if (!run.ok) return run;
      if (signal.aborted)
        return { ok: false, reason: 'unreachable', error: 'The scan was stopped.' };
      const facts = parseScanOutput(run.output.stdout);
      if (!facts.os) {
        return {
          ok: false,
          reason: 'unsupported',
          error: 'The machine did not answer like Linux, macOS or Windows.',
        };
      }
      const scopes = facts.runners.flatMap((runner) => {
        const scope = runner.registration ? parseGithubUrl(runner.registration.url) : null;
        return scope ? [scope] : [];
      });
      const plan = planCleanup(facts, await registrations(scopes));
      const scanId = deps.newId();
      scans.set(machineKeyOf(link), {
        scanId,
        steps: plan.steps,
        home: facts.home,
        runnerDirs: facts.runners.map((runner) => runner.dir),
      });
      const schedule: RunnerCleanupScheduleState = {
        installed: facts.schedule.installed,
        job: jobFor(facts.os, run.kind),
        schedule: readScheduleConfig(facts.schedule.config),
      };
      const lastRun = parseLastRun(facts.schedule.lastLog);
      if (lastRun) schedule.lastRun = lastRun;
      if (facts.os === 'linux' && facts.schedule.noCron) schedule.unavailable = NO_CRON;
      return {
        ok: true,
        scan: {
          scanId,
          os: facts.os,
          scannedAt: deps.now(),
          disk: facts.disk,
          groups: plan.groups,
          schedule,
          notes: plan.notes,
        },
      };
    });
  }

  function clean(
    request: RunnerCleanupCleanRequest,
    onOutcome?: (outcome: RunnerCleanupItemOutcome) => void,
  ): Promise<RunnerCleanupCleanResult> {
    const key = machineKeyOf(request.link);
    const held = scans.get(key);
    const refused = (error: string) => ({ ok: false as const, reason: 'refused' as const, error });
    if (!held || held.scanId !== request.scanId) {
      return Promise.resolve(refused('This scan is out of date. Scan the machine again.'));
    }
    const wanted = new Set(request.itemIds);
    if (wanted.size === 0) return Promise.resolve(refused('Nothing was picked.'));
    if ([...wanted].some((id) => !held.steps.has(id))) {
      return Promise.resolve(refused('The cleanup named something the scan did not find.'));
    }
    const steps = [...held.steps.values()].filter((step) => wanted.has(step.id));
    for (const step of steps) {
      const problem = unsafeStep(step, { home: held.home, runnerDirs: held.runnerDirs });
      if (problem) return Promise.resolve(refused(problem));
    }
    return exclusive(request.link, async (signal) => {
      // Sizes change once anything is removed, so this scan cannot be cleaned from again.
      scans.delete(key);
      const outcomes = new Map<string, RunnerCleanupItemOutcome>();
      const run = await deps.shell.run(
        request.link,
        (kind) => (kind === 'windows' ? windowsCleanScript(steps) : posixCleanScript(steps)),
        {
          timeoutMs: CLEAN_TIMEOUT_MS,
          signal,
          onLine: (text) => {
            const outcome = parseCleanLine(text);
            if (!outcome || !wanted.has(outcome.id) || outcomes.has(outcome.id)) return;
            outcomes.set(outcome.id, outcome);
            onOutcome?.(outcome);
          },
        },
      );
      if (!run.ok && outcomes.size === 0) return run;
      const all = steps.map(
        (step) =>
          outcomes.get(step.id) ?? {
            id: step.id,
            status: 'failed' as const,
            freedBytes: 0,
            error: run.ok ? NO_ANSWER : run.error,
          },
      );
      return {
        ok: true,
        outcomes: all,
        freedBytes: all.reduce((total, outcome) => total + outcome.freedBytes, 0),
      };
    });
  }

  function saveSchedule(
    link: RunnerMachineLink,
    raw: unknown,
  ): Promise<RunnerCleanupScheduleResult> {
    const schedule = normalizeSchedule(raw);
    if (!schedule) {
      return Promise.resolve({
        ok: false,
        reason: 'refused',
        error: 'That schedule is not valid.',
      });
    }
    return exclusive(link, async () => {
      const run = await deps.shell.run(
        link,
        (kind) =>
          kind === 'windows' ? windowsInstallScript(schedule) : posixInstallAnyScript(schedule),
        { timeoutMs: SCHEDULE_TIMEOUT_MS },
      );
      if (!run.ok) return run;
      const answer = lastAnswer(run.output.stdout);
      const job = jobFor(parseScanOutput(run.output.stdout).os, run.kind);
      if (!answer) {
        return {
          ok: false,
          reason: 'unreachable',
          error: 'The machine did not say whether the job was saved.',
        };
      }
      if (!answer.ok) {
        return answer.error === 'nocron'
          ? { ok: false, reason: 'unsupported', error: NO_CRON }
          : { ok: false, reason: 'unreachable', error: answer.error };
      }
      const result: RunnerCleanupScheduleResult = {
        ok: true,
        state: { installed: true, job, schedule },
      };
      if (answer.note === 'later') {
        result.note = 'The job starts working after the next sign-in on that Mac.';
      } else if (answer.note === 'interactive') {
        result.note =
          'Task Scheduler only allowed it to run while this account is signed in on that machine.';
      }
      return result;
    });
  }

  function removeSchedule(link: RunnerMachineLink): Promise<RunnerCleanupScheduleResult> {
    return exclusive(link, async () => {
      const run = await deps.shell.run(
        link,
        (kind) => (kind === 'windows' ? windowsRemoveScript() : posixRemoveAnyScript()),
        { timeoutMs: SCHEDULE_TIMEOUT_MS },
      );
      if (!run.ok) return run;
      const answer = lastAnswer(run.output.stdout);
      if (!answer?.ok) {
        return {
          ok: false,
          reason: 'unreachable',
          error: answer?.error ?? 'The machine did not say whether the job was removed.',
        };
      }
      return {
        ok: true,
        state: {
          installed: false,
          job: jobFor(parseScanOutput(run.output.stdout).os, run.kind),
          schedule: null,
        },
      };
    });
  }

  /** Stops a scan on this computer. Over SSH the machine finishes on its own and the answer is dropped. */
  function cancel(link: RunnerMachineLink): boolean {
    const abort = aborts.get(machineKeyOf(link));
    if (!abort) return false;
    abort.abort();
    return true;
  }

  return { scan, clean, saveSchedule, removeSchedule, cancel };
}

export type RunnerCleanupService = ReturnType<typeof createRunnerCleanupService>;
