import { describe, expect, it, vi } from 'vitest';
import type { RunnerMachineLink } from '../../../shared/apiTypes';
import type { MachineRun, RunOptions, ShellKind } from './machineShell';
import { DEFAULT_SCHEDULE } from './schedule';
import { createRunnerCleanupService, type RunnerCleanupServiceDeps } from './service';

const T = '\t';
const line = (...fields: string[]) => fields.join(T);
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const DIR = '/home/ci/actions-runner/build-01';
const LOCAL: RunnerMachineLink = { kind: 'local' };

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const SCAN = [
  line('os', 'Linux'),
  line('home', '/home/ci'),
  line('step', 'runners'),
  line('runner', DIR),
  line('runnerfile', DIR),
  line(
    'runnerjson',
    DIR,
    b64(
      JSON.stringify({
        agentId: 1,
        agentName: 'build-01',
        gitHubUrl: 'https://github.com/acme/web',
      }),
    ),
  ),
  line('configured', DIR),
  line('size', DIR, 'temp', '2048', `${DIR}/_work/_temp`),
  line('size', DIR, 'checkout', '4096', `${DIR}/_work/web`),
  line('size', DIR, 'total', '9000', DIR),
  line('step', 'docker'),
  line('docker', 'missing'),
  line('step', 'caches'),
  line('disk', '/dev/sda1 1000 600 400 60% /'),
  line('step', 'schedule'),
  line('sched', 'installed', 'cron'),
  line('schedconfig', JSON.stringify(DEFAULT_SCHEDULE)),
  line('schedlog', '2026-11-15T03:00:00Z', '100', 'ok'),
].join('\n');

type Script = { kind: ShellKind; script: string };

function shellAnswering(answer: (script: Script) => string | MachineRun) {
  const scripts: Script[] = [];
  const run = vi.fn(
    async (
      _link: RunnerMachineLink,
      build: (kind: ShellKind) => string,
      options: RunOptions,
    ): Promise<MachineRun> => {
      const script = { kind: 'posix' as ShellKind, script: build('posix') };
      scripts.push(script);
      const result = answer(script);
      if (typeof result !== 'string') return result;
      for (const text of result.split('\n')) options.onLine?.(text);
      return {
        ok: true,
        kind: 'posix',
        output: { stdout: result, stderr: '', exitCode: 0, timedOut: false },
      };
    },
  );
  return { run, scripts };
}

function service(
  answer: (script: Script) => string | MachineRun,
  overrides: Partial<RunnerCleanupServiceDeps> = {},
) {
  const shell = shellAnswering(answer);
  let id = 0;
  const svc = createRunnerCleanupService({
    shell: { run: shell.run },
    registeredRunners: async () => [{ id: 1, name: 'build-01' }],
    now: () => 1_700_000_000_000,
    newId: () => `scan-${++id}`,
    ...overrides,
  });
  return { svc, shell };
}

describe('scan', () => {
  it('reads the machine, plans the items and reports progress', async () => {
    const steps: string[] = [];
    const { svc } = service(() => SCAN);
    const result = await svc.scan(LOCAL, (step) => steps.push(step));
    expect(steps).toEqual(['runners', 'docker', 'caches', 'schedule']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scan).toMatchObject({
      scanId: 'scan-1',
      os: 'linux',
      scannedAt: 1_700_000_000_000,
      disk: { usedBytes: 600 * 1024, totalBytes: 1000 * 1024, mount: '/' },
      schedule: {
        installed: true,
        job: 'cron',
        schedule: DEFAULT_SCHEDULE,
        lastRun: { at: '2026-11-15T03:00:00Z', freedBytes: 100 * 1024, ok: true },
      },
    });
    expect(result.scan.groups[0].items.map((item) => item.id)).toEqual(['r0-temp', 'r0-checkouts']);
  });

  it('asks GitHub once per scope', async () => {
    const registeredRunners = vi.fn(async () => [{ id: 1, name: 'build-01' }]);
    const { svc } = service(() => `${SCAN}\n${SCAN.replaceAll(DIR, '/opt/second')}`, {
      registeredRunners,
    });
    await svc.scan(LOCAL);
    expect(registeredRunners).toHaveBeenCalledTimes(1);
    expect(registeredRunners).toHaveBeenCalledWith({ kind: 'repo', name: 'acme/web' });
  });

  it('says a machine that is not Linux, macOS or Windows is not supported', async () => {
    const { svc } = service(() => 'hello');
    expect(await svc.scan(LOCAL)).toMatchObject({ ok: false, reason: 'unsupported' });
  });

  it('passes on why the machine could not be reached', async () => {
    const { svc } = service(() => ({ ok: false, reason: 'locked', error: 'locked' }));
    expect(await svc.scan(LOCAL)).toEqual({ ok: false, reason: 'locked', error: 'locked' });
  });

  it('says a Linux server without cron cannot take a job', async () => {
    const { svc } = service(() => `${line('os', 'Linux')}\nnocron`);
    const result = await svc.scan(LOCAL);
    expect(result.ok && result.scan.schedule.unavailable).toMatch(/cron/);
  });
});

describe('clean', () => {
  it('runs the picked items only and reports each as it finishes', async () => {
    const { svc, shell } = service((script) =>
      script.script.includes('rv_scan_runner')
        ? SCAN
        : [line('@@done', 'r0-temp', '2048'), 'noise'].join('\n'),
    );
    const scan = await svc.scan(LOCAL);
    if (!scan.ok) throw new Error('scan failed');
    const seen: string[] = [];
    const result = await svc.clean(
      { link: LOCAL, scanId: scan.scan.scanId, itemIds: ['r0-temp'] },
      (outcome) => seen.push(`${outcome.id}:${outcome.status}`),
    );
    expect(result).toEqual({
      ok: true,
      outcomes: [{ id: 'r0-temp', status: 'done', freedBytes: 2048 * 1024 }],
      freedBytes: 2048 * 1024,
    });
    expect(seen).toEqual(['r0-temp:done']);
    const cleanScript = shell.scripts[1].script;
    expect(cleanScript).toContain(`${DIR}/_work/_temp`);
    expect(cleanScript).not.toContain(`${DIR}/_work/web`);
  });

  it('marks an item the machine never answered for as failed', async () => {
    const { svc } = service((script) => (script.script.includes('rv_scan_runner') ? SCAN : ''));
    const scan = await svc.scan(LOCAL);
    if (!scan.ok) throw new Error('scan failed');
    const result = await svc.clean({ link: LOCAL, scanId: scan.scan.scanId, itemIds: ['r0-temp'] });
    expect(result).toMatchObject({
      ok: true,
      outcomes: [{ id: 'r0-temp', status: 'failed', error: expect.any(String) }],
    });
  });

  it('refuses an old scan, an unknown item and an empty list', async () => {
    const { svc } = service(() => SCAN);
    const scan = await svc.scan(LOCAL);
    if (!scan.ok) throw new Error('scan failed');
    expect(await svc.clean({ link: LOCAL, scanId: 'other', itemIds: ['r0-temp'] })).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(
      await svc.clean({ link: LOCAL, scanId: scan.scan.scanId, itemIds: ['r0-nope'] }),
    ).toMatchObject({ ok: false, reason: 'refused' });
    expect(await svc.clean({ link: LOCAL, scanId: scan.scan.scanId, itemIds: [] })).toMatchObject({
      ok: false,
      reason: 'refused',
    });
  });

  it('needs a new scan after a cleanup, since the sizes changed', async () => {
    const { svc } = service((script) =>
      script.script.includes('rv_scan_runner') ? SCAN : line('@@done', 'r0-temp', '1'),
    );
    const scan = await svc.scan(LOCAL);
    if (!scan.ok) throw new Error('scan failed');
    const request = { link: LOCAL, scanId: scan.scan.scanId, itemIds: ['r0-temp'] };
    await svc.clean(request);
    expect(await svc.clean(request)).toMatchObject({ ok: false, reason: 'refused' });
  });
});

describe('one operation per machine', () => {
  it('says the machine is busy while another scan runs there', async () => {
    const { promise: gate, resolve: release } = deferred<void>();
    const shell = {
      run: vi.fn(async (): Promise<MachineRun> => {
        await gate;
        return {
          ok: true,
          kind: 'posix',
          output: { stdout: SCAN, stderr: '', exitCode: 0, timedOut: false },
        };
      }),
    };
    const svc = createRunnerCleanupService({
      shell,
      registeredRunners: async () => null,
      now: () => 0,
      newId: () => 'id',
    });
    const first = svc.scan(LOCAL);
    expect(await svc.scan(LOCAL)).toMatchObject({ ok: false, reason: 'working' });
    // Another machine is not held up.
    const other = svc.scan({ kind: 'ssh', serverId: 'other' });
    release();
    expect((await first).ok).toBe(true);
    expect((await other).ok).toBe(true);
    expect((await svc.scan(LOCAL)).ok).toBe(true);
  });
});

describe('schedule', () => {
  it('installs the job and reports what it set up', async () => {
    const { svc, shell } = service(() => [line('os', 'Linux'), '@@ok'].join('\n'));
    const result = await svc.saveSchedule(LOCAL, DEFAULT_SCHEDULE);
    expect(result).toEqual({
      ok: true,
      state: { installed: true, job: 'cron', schedule: DEFAULT_SCHEDULE },
    });
    expect(shell.scripts[0].script).toContain('crontab');
  });

  it('passes on a note, and explains a missing crontab', async () => {
    const mac = service(() => [line('os', 'Darwin'), line('@@ok', 'later')].join('\n'));
    expect(await mac.svc.saveSchedule(LOCAL, DEFAULT_SCHEDULE)).toMatchObject({
      ok: true,
      state: { job: 'launchd' },
      note: expect.stringMatching(/sign/),
    });
    const noCron = service(() => [line('os', 'Linux'), line('@@error', 'nocron')].join('\n'));
    expect(await noCron.svc.saveSchedule(LOCAL, DEFAULT_SCHEDULE)).toMatchObject({
      ok: false,
      reason: 'unsupported',
      error: expect.stringMatching(/apt install cron/),
    });
  });

  it('refuses a schedule that is not valid', async () => {
    const { svc, shell } = service(() => '@@ok');
    expect(await svc.saveSchedule(LOCAL, { ...DEFAULT_SCHEDULE, time: '99:99' })).toMatchObject({
      ok: false,
      reason: 'refused',
    });
    expect(shell.run).not.toHaveBeenCalled();
  });

  it('removes the job', async () => {
    const { svc } = service(() => [line('os', 'Linux'), '@@ok'].join('\n'));
    expect(await svc.removeSchedule(LOCAL)).toEqual({
      ok: true,
      state: { installed: false, job: 'cron', schedule: null },
    });
  });

  it('uses the Windows scripts on Windows', async () => {
    const run = vi.fn(
      async (_link: RunnerMachineLink, build: (kind: ShellKind) => string): Promise<MachineRun> => {
        expect(build('windows')).toContain('Register-ScheduledTask');
        return {
          ok: true,
          kind: 'windows',
          output: { stdout: '@@ok\r\n', stderr: '', exitCode: 0, timedOut: false },
        };
      },
    );
    const svc = createRunnerCleanupService({
      shell: { run },
      registeredRunners: async () => null,
      now: () => 0,
      newId: () => 'id',
    });
    expect(await svc.saveSchedule(LOCAL, DEFAULT_SCHEDULE)).toMatchObject({
      ok: true,
      state: { job: 'task' },
    });
  });
});
