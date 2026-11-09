import { MANAGE_METHODS } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type ManageErrorTrackingDeps,
  type ManageMonitoringDeps,
  type ManagePipelineDeps,
  opsMethods,
} from './opsMethods';
import { ManageError } from './session';

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['ops' as const] } };

const target = {
  id: 'h1',
  name: 'API',
  cloud: null,
  paused: false,
  state: 'pass',
  latencyMs: 42,
  uptime24h: 99.5,
  headline: 'All good',
  samples: [{ at: 1, state: 'pass', latencyMs: 40 }],
  secretEnvelope: 'never',
};

function monitoring(change: Partial<ManageMonitoringDeps> = {}): ManageMonitoringDeps {
  return {
    list: async () => [target as never],
    check: async () => undefined,
    setPaused: async () => undefined,
    ...change,
  };
}

const workflow = {
  id: 7,
  name: 'CI',
  path: '.github/workflows/ci.yml',
  state: 'active',
  htmlUrl: 'u',
  badgeUrl: 'b',
  dispatchable: true,
  dispatchInputs: [],
};
const run = {
  id: 100,
  workflowId: 7,
  name: 'CI',
  displayTitle: 'Fix it',
  runNumber: 12,
  headBranch: 'master',
  status: 'in_progress',
  conclusion: null,
  htmlUrl: 'u',
  createdAt: 'a',
  updatedAt: 'b',
};
const step = {
  number: 1,
  name: 's',
  status: 'completed',
  conclusion: 'success',
  startedAt: 'a',
  completedAt: 'b',
};
const job = {
  id: 5,
  name: 'build',
  status: 'completed',
  conclusion: 'failure',
  startedAt: 'a',
  completedAt: 'b',
  htmlUrl: 'u',
  runnerName: 'r',
  steps: [step],
};

function pipelines(change: Partial<ManagePipelineDeps> = {}): ManagePipelineDeps {
  return {
    status: async () =>
      ({
        projectId: 'p1',
        cliAvailable: true,
        authenticated: true,
        github: { owner: 'sam', repo: 'site' },
        workflows: [workflow],
        runsByWorkflowId: { 7: run },
      }) as never,
    repoOf: async () => 'sam/site',
    details: async () => ({ ok: true, jobs: [job] }) as never,
    jobLog: async () =>
      ({
        ok: true,
        steps: [
          {
            number: 1,
            lines: [
              { text: 'hello', kind: 'plain' },
              { text: 'boom', kind: 'error' },
            ],
            errors: 1,
            warnings: 0,
          },
        ],
      }) as never,
    refs: async () => ({ ok: true, defaultBranch: 'main', branches: [], tags: [] }) as never,
    dispatch: async () => ({ ok: true }) as never,
    cancel: async () => ({ ok: true }) as never,
    afterAction: () => undefined,
    ...change,
  };
}

const NOW = Date.parse('2026-03-01T12:00:00.000Z');

const issue = {
  id: '42',
  shortId: 'WEB-3F',
  title: 'TypeError: boom',
  culprit: 'checkout/index',
  level: 'error',
  status: 'unresolved',
  count: 12,
  userCount: 3,
  firstSeen: '2026-02-20T00:00:00.000Z',
  lastSeen: '2026-03-01T11:00:00.000Z',
  permalink: 'https://sentry.example/42',
  remoteProjectId: 'r1',
  remoteProjectSlug: 'web',
  trend: [1, 2],
  connectionId: 'c1',
  projectId: 'p1',
  isNew: true,
};

function errorTracking(change: Partial<ManageErrorTrackingDeps> = {}): ManageErrorTrackingDeps {
  return {
    issues: async () =>
      ({ issues: [issue], nextCursor: null, failures: [], fetchedAt: NOW }) as never,
    linked: async () => true,
    issue: async () => ({ issue, event: null, canWrite: true }) as never,
    setStatus: async () => issue as never,
    now: () => NOW,
    ...change,
  };
}

function call(
  method: string,
  params: unknown,
  m = monitoring(),
  p = pipelines(),
  e = errorTracking(),
) {
  return opsMethods(m, p, e)[method](params, context);
}

describe('monitoring methods', () => {
  it('lists what this computer checks, without anything secret', async () => {
    const [item] = (await call('monitoring.list', undefined)) as Record<string, unknown>[];

    expect(item).toEqual({
      id: 'h1',
      name: 'API',
      state: 'pass',
      paused: false,
      latencyMs: 42,
      uptime24h: 99.5,
      headline: 'All good',
      samples: [40],
    });
  });

  it('leaves out cloud monitors, which the phone reads from Runova itself', async () => {
    const onCloud = { ...target, cloud: { id: 'c' } };

    await expect(
      call('monitoring.list', undefined, monitoring({ list: async () => [onCloud as never] })),
    ).resolves.toEqual([]);
  });

  it('checks one now', async () => {
    const check = vi.fn(async () => undefined);

    await expect(call('monitoring.check', { id: 'h1' }, monitoring({ check }))).resolves.toEqual({
      ok: true,
      message: 'Checked.',
    });
    expect(check).toHaveBeenCalledWith('h1');
  });

  it('pauses and resumes', async () => {
    const setPaused = vi.fn(async () => undefined);

    await call('monitoring.pause', { id: 'h1', paused: true }, monitoring({ setPaused }));

    expect(setPaused).toHaveBeenCalledWith('h1', true);
  });

  it('needs to know which way to switch', async () => {
    await expect(call('monitoring.pause', { id: 'h1' }, monitoring())).rejects.toBeInstanceOf(
      ManageError,
    );
  });
});

describe('error tracking methods', () => {
  const ref = { connectionId: 'c1', issueId: '42' };
  const errorsCall = (method: string, params: unknown, e: ManageErrorTrackingDeps) =>
    call(method, params, monitoring(), pipelines(), e);

  it('asks for what the desktop shows first: unresolved, last 14 days, newest first', async () => {
    const issues = vi.fn(async () => ({ issues: [], nextCursor: null, failures: [] }) as never);

    await errorsCall('errors.list', undefined, errorTracking({ issues }));

    expect(issues).toHaveBeenCalledWith({ status: 'unresolved', period: '14d', sort: 'lastSeen' });
  });

  it('lists issues with no provider link and a time measured here', async () => {
    const result = (await call('errors.list', undefined)) as {
      linked: boolean;
      truncated: boolean;
      issues: Record<string, unknown>[];
    };

    expect(result.linked).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.issues[0]).toEqual({
      connectionId: 'c1',
      id: '42',
      shortId: 'WEB-3F',
      title: 'TypeError: boom',
      culprit: 'checkout/index',
      level: 'error',
      status: 'unresolved',
      count: 12,
      userCount: 3,
      isNew: true,
      projectId: 'p1',
      remoteProject: 'web',
      lastSeenAgoMs: 3_600_000,
    });
  });

  it('says so when nothing is linked', async () => {
    const result = (await errorsCall(
      'errors.list',
      undefined,
      errorTracking({ linked: async () => false }),
    )) as { linked: boolean };

    expect(result.linked).toBe(false);
  });

  it('caps a very long list and very long text', async () => {
    const issues = Array.from({ length: 80 }, (_, n) => ({
      ...issue,
      id: String(n),
      title: 'x'.repeat(5000),
    }));
    const result = (await errorsCall(
      'errors.list',
      undefined,
      errorTracking({
        issues: async () => ({ issues, nextCursor: null, failures: [], fetchedAt: NOW }) as never,
      }),
    )) as { truncated: boolean; issues: { title: string }[] };

    expect(result.issues).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.issues[0].title.length).toBeLessThanOrEqual(200);
  });

  it('marks the list as cut when there are more pages', async () => {
    const result = (await errorsCall(
      'errors.list',
      undefined,
      errorTracking({
        issues: async () =>
          ({ issues: [issue], nextCursor: 'abc', failures: [], fetchedAt: NOW }) as never,
      }),
    )) as { truncated: boolean };

    expect(result.truncated).toBe(true);
  });

  it('passes on connections it could not read', async () => {
    const failures = [
      { connectionId: 'c1', label: 'Acme', message: 'Vault is locked', locked: true },
    ];
    const result = (await errorsCall(
      'errors.list',
      undefined,
      errorTracking({
        issues: async () => ({ issues: [], nextCursor: null, failures, fetchedAt: NOW }) as never,
      }),
    )) as { problems: { label: string; locked: boolean }[] };

    expect(result.problems).toEqual([{ label: 'Acme', message: 'Vault is locked', locked: true }]);
  });

  const frame = (filename: string, inApp: boolean) => ({
    filename,
    function: 'run',
    module: null,
    lineNo: 7,
    colNo: 2,
    inApp,
    context: [[7, 'secret source line']],
  });

  function detailOf(event: Record<string, unknown>) {
    return async () => ({ issue, event, canWrite: false }) as never;
  }

  const event = {
    eventId: 'e1',
    dateCreated: '2026-03-01T11:00:00.000Z',
    platform: 'node',
    message: null,
    exceptions: [
      {
        type: 'RangeError',
        value: 'first',
        module: null,
        handled: true,
        frames: [frame('a.ts', true)],
      },
      {
        type: 'TypeError',
        value: 'thrown',
        module: null,
        handled: false,
        frames: [frame('lib.js', false), frame('app.ts', true)],
      },
    ],
    breadcrumbs: [{ timestamp: null, category: 'ui', level: 'info', message: 'clicked' }],
    request: { method: 'POST', url: 'https://x.test/pay?card=*' },
    tags: [{ key: 'browser', value: 'Chrome' }],
    environment: 'production',
    release: '1.4.2',
    userId: 'u1',
  };

  it('shows the thrown exception first, its own code only, and no source lines', async () => {
    const result = (await errorsCall(
      'errors.show',
      ref,
      errorTracking({ issue: detailOf(event) }),
    )) as {
      canChange: boolean;
      event: Record<string, unknown> & {
        exceptions: { type: string; handled: boolean; frames: Record<string, unknown>[] }[];
      };
    };

    expect(result.canChange).toBe(false);
    expect(result.event.exceptions.map((one) => one.type)).toEqual(['TypeError', 'RangeError']);
    expect(result.event.exceptions[0].frames).toEqual([
      { file: 'app.ts', function: 'run', line: 7 },
    ]);
    expect(result.event.request).toBe('POST https://x.test/pay?card=*');
    expect(result.event.environment).toBe('production');
    expect(JSON.stringify(result)).not.toContain('secret source line');
    expect(JSON.stringify(result)).not.toContain('clicked');
    expect(JSON.stringify(result)).not.toContain('u1');
  });

  it('shows library frames when none of the frames are the app own', async () => {
    const libraryOnly = {
      ...event,
      exceptions: [
        { type: 'E', value: 'v', module: null, handled: null, frames: [frame('lib.js', false)] },
      ],
    };
    const result = (await errorsCall(
      'errors.show',
      ref,
      errorTracking({ issue: detailOf(libraryOnly) }),
    )) as { event: { exceptions: { frames: { file: string }[] }[] } };

    expect(result.event.exceptions[0].frames[0].file).toBe('lib.js');
  });

  it('caps frames, exceptions and tags', async () => {
    const big = {
      ...event,
      message: 'm'.repeat(5000),
      exceptions: Array.from({ length: 6 }, () => ({
        type: 'E',
        value: 'v'.repeat(5000),
        module: null,
        handled: null,
        frames: Array.from({ length: 60 }, () => frame('a.ts', true)),
      })),
      tags: Array.from({ length: 60 }, (_, n) => ({ key: `k${n}`, value: 'v' })),
    };
    const result = (await errorsCall(
      'errors.show',
      ref,
      errorTracking({ issue: detailOf(big) }),
    )) as {
      event: {
        message: string;
        exceptions: { value: string; frames: unknown[] }[];
        tags: unknown[];
      };
    };

    expect(result.event.exceptions).toHaveLength(3);
    expect(result.event.exceptions[0].frames).toHaveLength(20);
    expect(result.event.exceptions[0].value.length).toBeLessThanOrEqual(500);
    expect(result.event.tags).toHaveLength(20);
    expect(result.event.message.length).toBeLessThanOrEqual(500);
  });

  it('refuses an issue id that is not one the provider could have made', async () => {
    await expect(
      call('errors.show', { connectionId: 'c1', issueId: '../../secrets' }),
    ).rejects.toBeInstanceOf(ManageError);
  });

  it('resolves and reopens, and nothing else', async () => {
    const setStatus = vi.fn(async () => issue as never);

    await expect(
      errorsCall('errors.setStatus', { ...ref, status: 'resolved' }, errorTracking({ setStatus })),
    ).resolves.toEqual({ ok: true, message: 'Resolved.' });
    await expect(
      errorsCall(
        'errors.setStatus',
        { ...ref, status: 'unresolved' },
        errorTracking({ setStatus }),
      ),
    ).resolves.toEqual({ ok: true, message: 'Reopened.' });
    await expect(
      errorsCall('errors.setStatus', { ...ref, status: 'ignored' }, errorTracking({ setStatus })),
    ).rejects.toBeInstanceOf(ManageError);

    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledWith({ ...ref, status: 'resolved' });
  });

  it('says why when the provider refuses, in the service own words', async () => {
    const setStatus = async () => {
      throw new Error('The token lacks event:write.');
    };

    await expect(
      errorsCall('errors.setStatus', { ...ref, status: 'resolved' }, errorTracking({ setStatus })),
    ).resolves.toEqual({ ok: false, message: 'The token lacks event:write.' });
  });

  it('files listing and reading as reads and changes as a write', () => {
    expect(MANAGE_METHODS['errors.list']).toEqual({ scope: 'ops', risk: 'read' });
    expect(MANAGE_METHODS['errors.show']).toEqual({ scope: 'ops', risk: 'read' });
    expect(MANAGE_METHODS['errors.setStatus']).toEqual({ scope: 'ops', risk: 'write' });
  });
});

describe('pipeline methods', () => {
  it('lists workflows with their latest run', async () => {
    const result = (await call('pipelines.status', { projectId: 'p1' })) as {
      problem: string | null;
      workflows: { id: number; canDispatch: boolean; run: { title: string; status: string } }[];
    };

    expect(result.problem).toBeNull();
    expect(result.workflows[0]).toMatchObject({ id: 7, canDispatch: true });
    expect(result.workflows[0].run).toMatchObject({ title: 'Fix it', status: 'in_progress' });
  });

  it('says when gh is not there', async () => {
    const status = async () =>
      ({
        projectId: 'p1',
        cliAvailable: false,
        authenticated: false,
        github: null,
        workflows: [],
        runsByWorkflowId: {},
      }) as never;

    await expect(
      call('pipelines.status', { projectId: 'p1' }, monitoring(), pipelines({ status })),
    ).resolves.toMatchObject({ problem: "GitHub CLI isn't installed on this computer." });
  });

  it('says when gh is not signed in', async () => {
    const status = async () =>
      ({
        projectId: 'p1',
        cliAvailable: true,
        authenticated: false,
        github: null,
        workflows: [],
        runsByWorkflowId: {},
      }) as never;

    await expect(
      call('pipelines.status', { projectId: 'p1' }, monitoring(), pipelines({ status })),
    ).resolves.toMatchObject({ problem: "GitHub CLI isn't signed in on this computer." });
  });

  it('shows the jobs of a run', async () => {
    const details = vi.fn(async () => ({ ok: true, jobs: [job] }) as never);

    const result = await call(
      'pipelines.run',
      { projectId: 'p1', runId: 100 },
      monitoring(),
      pipelines({ details }),
    );

    expect(details).toHaveBeenCalledWith({ repo: 'sam/site', runId: 100 });
    expect(result).toEqual({
      jobs: [{ id: 5, name: 'build', status: 'completed', conclusion: 'failure' }],
    });
  });

  it('flattens a job log', async () => {
    const result = await call('pipelines.jobLog', { projectId: 'p1', runId: 100, jobId: 5 });

    expect(result).toEqual({
      truncated: false,
      lines: [
        { text: 'hello', error: false },
        { text: 'boom', error: true },
      ],
    });
  });

  it('keeps the end of a very long log', async () => {
    const lines = Array.from({ length: 3000 }, (_, n) => ({ text: `line ${n}`, kind: 'plain' }));
    const jobLog = async () =>
      ({ ok: true, steps: [{ number: 1, lines, errors: 0, warnings: 0 }] }) as never;

    const result = (await call(
      'pipelines.jobLog',
      { projectId: 'p1', runId: 100, jobId: 5 },
      monitoring(),
      pipelines({ jobLog }),
    )) as { truncated: boolean; lines: { text: string }[] };

    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(2000);
    expect(result.lines.at(-1)?.text).toBe('line 2999');
  });

  it('says what inputs a workflow takes', async () => {
    const input = {
      name: 'version',
      description: 'Which version',
      required: true,
      type: 'string',
      default: '',
      options: [],
    };
    const status = async () =>
      ({
        projectId: 'p1',
        cliAvailable: true,
        authenticated: true,
        github: { owner: 'sam', repo: 'site' },
        workflows: [{ ...workflow, dispatchInputs: [input] }],
        runsByWorkflowId: {},
      }) as never;

    const result = (await call(
      'pipelines.status',
      { projectId: 'p1' },
      monitoring(),
      pipelines({ status }),
    )) as { workflows: { inputs: unknown[] }[] };

    expect(result.workflows[0].inputs).toEqual([input]);
  });

  it('passes the inputs it was given along', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }) as never);

    await call(
      'pipelines.dispatch',
      { projectId: 'p1', workflowId: 7, inputs: { version: '1.2.3' } },
      monitoring(),
      pipelines({ dispatch }),
    );

    expect(dispatch).toHaveBeenCalledWith({
      repo: 'sam/site',
      workflowId: 7,
      ref: 'main',
      inputs: { version: '1.2.3' },
    });
  });

  it('refuses inputs that are not short named strings', async () => {
    for (const inputs of [
      { version: 1 },
      { 'bad name': 'x' },
      { version: 'x'.repeat(5000) },
      Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`k${n}`, 'x'])),
      ['x'],
    ]) {
      await expect(
        call('pipelines.dispatch', { projectId: 'p1', workflowId: 7, inputs }),
      ).rejects.toBeInstanceOf(ManageError);
    }
  });

  it('dispatches on the default branch', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }) as never);
    const afterAction = vi.fn();

    const result = await call(
      'pipelines.dispatch',
      { projectId: 'p1', workflowId: 7 },
      monitoring(),
      pipelines({ dispatch, afterAction }),
    );

    expect(dispatch).toHaveBeenCalledWith({
      repo: 'sam/site',
      workflowId: 7,
      ref: 'main',
      inputs: {},
    });
    expect(afterAction).toHaveBeenCalledWith('p1');
    expect(result).toEqual({ ok: true, message: 'Started.' });
  });

  it('cancels a run and passes on why it could not', async () => {
    const cancel = async () => ({ ok: false, error: 'Already finished' }) as never;

    await expect(
      call(
        'pipelines.cancel',
        { projectId: 'p1', runId: 100 },
        monitoring(),
        pipelines({ cancel }),
      ),
    ).resolves.toEqual({ ok: false, message: 'Already finished' });
  });

  it('files dispatch and cancel as risky, and everything under ops', () => {
    expect(MANAGE_METHODS['pipelines.dispatch'].risk).toBe('danger');
    expect(MANAGE_METHODS['pipelines.cancel'].risk).toBe('danger');
    for (const [name, method] of Object.entries(MANAGE_METHODS)) {
      if (
        name.startsWith('pipelines.') ||
        name.startsWith('monitoring.') ||
        name.startsWith('errors.')
      ) {
        expect(method.scope).toBe('ops');
      }
    }
  });

  it('runs every method the protocol names for ops', () => {
    const named = Object.keys(MANAGE_METHODS).filter(
      (name) =>
        name.startsWith('pipelines.') ||
        name.startsWith('monitoring.') ||
        name.startsWith('errors.'),
    );

    expect(Object.keys(opsMethods(monitoring(), pipelines(), errorTracking())).sort()).toEqual(
      named.sort(),
    );
  });
});
