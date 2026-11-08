import { MANAGE_METHODS } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type ManageMonitoringDeps, type ManagePipelineDeps, opsMethods } from './opsMethods';
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

function call(method: string, params: unknown, m = monitoring(), p = pipelines()) {
  return opsMethods(m, p)[method](params, context);
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
      if (name.startsWith('pipelines.') || name.startsWith('monitoring.')) {
        expect(method.scope).toBe('ops');
      }
    }
  });

  it('runs every method the protocol names for ops', () => {
    const named = Object.keys(MANAGE_METHODS).filter(
      (name) => name.startsWith('pipelines.') || name.startsWith('monitoring.'),
    );

    expect(Object.keys(opsMethods(monitoring(), pipelines())).sort()).toEqual(named.sort());
  });
});
