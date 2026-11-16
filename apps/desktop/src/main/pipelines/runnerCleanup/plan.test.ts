import { describe, expect, it } from 'vitest';
import { planCleanup, type RegisteredRunners, scopeKey } from './plan';
import type { MachineFacts, RunnerFolderFacts } from './scanParse';

const MB = 1024 * 1024;
const DIR = '/home/ci/actions-runner/build-01';

function runner(overrides: Partial<RunnerFolderFacts> = {}): RunnerFolderFacts {
  return {
    dir: DIR,
    registration: { agentId: 42, name: 'build-01', url: 'https://github.com/acme/web' },
    hasRunnerFile: true,
    configured: true,
    service: 'actions.runner.acme-web.build-01.service',
    busy: false,
    sizes: [
      { kind: 'checkout', bytes: 300 * MB, path: `${DIR}/_work/web` },
      { kind: 'checkout', bytes: 100 * MB, path: `${DIR}/_work/api` },
      { kind: 'temp', bytes: 5 * MB, path: `${DIR}/_work/_temp` },
      { kind: 'actions', bytes: 20 * MB, path: `${DIR}/_work/_actions` },
      { kind: 'tool', bytes: 80 * MB, path: `${DIR}/_work/_tool/node/18.20.4` },
      { kind: 'tool', bytes: 90 * MB, path: `${DIR}/_work/_tool/node/20.11.1` },
      { kind: 'tool', bytes: 60 * MB, path: `${DIR}/_work/_tool/Python/3.12.1` },
      { kind: 'diag', bytes: 2 * MB, path: `${DIR}/_diag` },
      { kind: 'oldver', bytes: 150 * MB, path: `${DIR}/bin.2.319.1` },
      { kind: 'oldver', bytes: 50 * MB, path: `${DIR}/externals.2.319.1` },
      { kind: 'total', bytes: 1200 * MB, path: DIR },
    ],
    ...overrides,
  };
}

function facts(overrides: Partial<MachineFacts> = {}): MachineFacts {
  return {
    os: 'linux',
    home: '/home/ci',
    runners: [runner()],
    busyUnknown: false,
    docker: { state: 'missing', viaSudo: false, rows: [], danglingBytes: 0 },
    caches: [],
    tools: new Set(),
    disk: null,
    schedule: { installed: false, job: null, config: null, lastLog: null, noCron: false },
    ...overrides,
  };
}

const registered = (entries: Record<string, { id: number; name: string }[] | null>) =>
  new Map(Object.entries(entries)) as RegisteredRunners;

const onGithub = registered({ 'repo:acme/web': [{ id: 42, name: 'build-01' }] });

describe('scopeKey', () => {
  it('names a repo and an org apart', () => {
    expect(scopeKey({ kind: 'repo', name: 'Acme/Web' })).toBe('repo:acme/web');
    expect(scopeKey({ kind: 'org', name: 'acme' })).toBe('org:acme');
  });
});

describe('planCleanup for a live runner', () => {
  const plan = planCleanup(facts(), onGithub);
  const group = plan.groups[0];
  const item = (suffix: string) => group.items.find((entry) => entry.id.endsWith(`-${suffix}`));

  it('makes one group for the runner, named after it', () => {
    expect(plan.groups).toHaveLength(1);
    expect(group).toMatchObject({
      kind: 'runner',
      title: 'build-01',
      status: 'idle',
    });
    expect(group.subtitle).toContain('acme/web');
    expect(group.subtitle).toContain(DIR);
  });

  it('picks the safe things and the leftovers of earlier runs, not what slows the next job', () => {
    expect(item('temp')).toMatchObject({ risk: 'safe', picked: true, bytes: 5 * MB });
    expect(item('logs')).toMatchObject({ risk: 'safe', picked: true, bytes: 2 * MB });
    expect(item('versions')).toMatchObject({ risk: 'safe', picked: true, bytes: 200 * MB });
    expect(item('checkouts')).toMatchObject({ risk: 'slows', picked: true, bytes: 400 * MB });
    expect(item('tools')).toMatchObject({ risk: 'slows', picked: true, bytes: 80 * MB });
    expect(item('actions')).toMatchObject({ risk: 'slows', picked: false, bytes: 20 * MB });
  });

  it('keeps the newest version of each tool and names the old ones', () => {
    expect(item('tools')?.why).toContain('node 18.20.4');
    const step = plan.steps.get(item('tools')?.id ?? '');
    expect(step?.actions).toEqual([{ kind: 'remove', path: `${DIR}/_work/_tool/node/18.20.4` }]);
  });

  it('names the repos whose checkouts would go', () => {
    expect(item('checkouts')?.label).toBe('Job checkouts (2 repos)');
    expect(item('checkouts')?.why).toContain('web, api');
  });

  it('guards the work folder against a job that starts, but not the logs', () => {
    expect(plan.steps.get(item('checkouts')?.id ?? '')?.busyGuard).toBe(DIR);
    expect(plan.steps.get(item('logs')?.id ?? '')).toEqual({
      id: item('logs')?.id,
      busyGuard: null,
      measure: [`${DIR}/_diag`],
      actions: [{ kind: 'oldLogs', path: `${DIR}/_diag`, days: 7 }],
    });
  });

  it('leaves out things that take no space', () => {
    const empty = planCleanup(
      facts({
        runners: [runner({ sizes: [{ kind: 'temp', bytes: 0, path: `${DIR}/_work/_temp` }] })],
      }),
      onGithub,
    );
    expect(empty.groups[0].items).toEqual([]);
  });
});

describe('planCleanup for a busy runner', () => {
  it('turns off what is in the work folder and says why', () => {
    const plan = planCleanup(facts({ runners: [runner({ busy: true })] }), onGithub);
    const [group] = plan.groups;
    expect(group.status).toBe('busy');
    const checkouts = group.items.find((entry) => entry.id.endsWith('-checkouts'));
    expect(checkouts).toMatchObject({
      picked: false,
      disabledReason: expect.stringMatching(/job/),
    });
    const logs = group.items.find((entry) => entry.id.endsWith('-logs'));
    expect(logs?.disabledReason).toBeUndefined();
  });

  it('treats every runner as busy when Windows hides which one runs a job', () => {
    const plan = planCleanup(facts({ busyUnknown: true }), onGithub);
    expect(plan.groups[0].status).toBe('busy');
  });
});

describe('planCleanup for runners that are gone', () => {
  it('offers a runner GitHub no longer has, unpicked and marked careful', () => {
    const plan = planCleanup(facts(), registered({ 'repo:acme/web': [{ id: 7, name: 'other' }] }));
    expect(plan.groups).toHaveLength(1);
    const [group] = plan.groups;
    expect(group.kind).toBe('abandoned');
    expect(group.items).toEqual([
      expect.objectContaining({
        label: 'build-01',
        risk: 'careful',
        picked: false,
        bytes: 1200 * MB,
      }),
    ]);
    expect(group.items[0].why).toContain('acme/web');
    expect(group.items[0].why).toContain('service');
    const step = plan.steps.get(group.items[0].id);
    expect(step?.actions).toEqual([{ kind: 'removeRunner', path: DIR }]);
  });

  it('counts a runner registered again under another id as gone', () => {
    const plan = planCleanup(
      facts(),
      registered({ 'repo:acme/web': [{ id: 99, name: 'build-01' }] }),
    );
    expect(plan.groups[0].kind).toBe('abandoned');
  });

  it('offers a folder that was never registered', () => {
    const plan = planCleanup(
      facts({
        runners: [
          runner({
            registration: null,
            hasRunnerFile: false,
            service: null,
            sizes: [{ kind: 'total', bytes: 180 * MB, path: DIR }],
          }),
        ],
      }),
      onGithub,
    );
    expect(plan.groups[0]).toMatchObject({ kind: 'abandoned' });
    expect(plan.groups[0].items[0].why).toMatch(/never registered/i);
  });

  it('never calls a runner gone when GitHub could not be asked or its file could not be read', () => {
    expect(planCleanup(facts(), registered({ 'repo:acme/web': null })).groups[0]).toMatchObject({
      kind: 'runner',
      status: 'unknown',
    });
    expect(planCleanup(facts(), registered({})).groups[0].kind).toBe('runner');
    const unreadable = planCleanup(
      facts({ runners: [runner({ registration: null, hasRunnerFile: true })] }),
      onGithub,
    );
    expect(unreadable.groups[0]).toMatchObject({ kind: 'runner', status: 'unknown' });
  });
});

describe('planCleanup for Docker', () => {
  const docker = {
    state: 'ok' as const,
    viaSudo: false,
    rows: [
      { type: 'Images', reclaimableBytes: 2000 * MB, totalCount: 10, active: 2 },
      { type: 'Containers', reclaimableBytes: 30 * MB, totalCount: 4, active: 1 },
      { type: 'Local Volumes', reclaimableBytes: 900 * MB, totalCount: 3, active: 0 },
      { type: 'Build Cache', reclaimableBytes: 700 * MB, totalCount: 50, active: 0 },
    ],
    danglingBytes: 500 * MB,
  };

  it('offers containers, dangling and unused images and the build cache, never volumes', () => {
    const plan = planCleanup(facts({ runners: [], docker }), onGithub);
    const [group] = plan.groups;
    expect(group.kind).toBe('docker');
    expect(group.items.map((entry) => [entry.id, entry.bytes, entry.picked])).toEqual([
      ['docker-containers', 30 * MB, true],
      ['docker-dangling', 500 * MB, true],
      ['docker-images', 1500 * MB, false],
      ['docker-build', 700 * MB, false],
    ]);
    expect(plan.steps.get('docker-images')?.actions).toEqual([{ kind: 'docker', prune: 'images' }]);
  });

  it('notes a Docker it could not use', () => {
    const plan = planCleanup(facts({ docker: { ...docker, state: 'denied', rows: [] } }), onGithub);
    expect(plan.notes.join(' ')).toMatch(/Docker/);
  });
});

describe('planCleanup for package caches', () => {
  it('uses the tool command for the login home when the tool is there', () => {
    const plan = planCleanup(
      facts({
        runners: [],
        tools: new Set(['npm']),
        caches: [
          { id: 'npm', home: '/home/ci', bytes: 900 * MB, path: '/home/ci/.npm/_cacache' },
          { id: 'npm', home: '/home/runner', bytes: 100 * MB, path: '/home/runner/.npm/_cacache' },
          { id: 'maven', home: '/home/ci', bytes: 50 * MB, path: '/home/ci/.m2/repository' },
        ],
      }),
      onGithub,
    );
    const [group] = plan.groups;
    expect(group.kind).toBe('caches');
    expect(group.items.map((entry) => [entry.label, entry.risk, entry.picked])).toEqual([
      ['npm cache', 'slows', false],
      ['npm cache (/home/runner)', 'slows', false],
      ['Maven repository', 'slows', false],
    ]);
    const [own, other, maven] = group.items.map((entry) => plan.steps.get(entry.id));
    expect(own?.actions).toEqual([
      {
        kind: 'toolCommand',
        tool: 'npm',
        args: ['cache', 'clean', '--force'],
        fallback: '/home/ci/.npm/_cacache',
      },
    ]);
    expect(other?.actions).toEqual([{ kind: 'empty', path: '/home/runner/.npm/_cacache' }]);
    expect(maven?.actions).toEqual([{ kind: 'empty', path: '/home/ci/.m2/repository' }]);
  });
});

describe('planCleanup ids', () => {
  it('gives every item a unique id that has a step', () => {
    const plan = planCleanup(
      facts({
        runners: [runner(), runner({ dir: '/opt/r2', registration: null, hasRunnerFile: false })],
        caches: [{ id: 'pip', home: '/home/ci', bytes: MB, path: '/home/ci/.cache/pip' }],
      }),
      onGithub,
    );
    const ids = plan.groups.flatMap((group) => group.items.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(plan.steps.has(id)).toBe(true);
  });
});
