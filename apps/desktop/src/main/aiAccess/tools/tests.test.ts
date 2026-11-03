import type { TestDiscovery, TestNode, TestRunSnapshot } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { AiTool, ToolContext } from '../registry';

function node(over: Partial<TestNode> & Pick<TestNode, 'id' | 'kind' | 'name'>): TestNode {
  return { testProjectId: 'vitest:web', path: [], children: [], ...over };
}

const discovery: TestDiscovery = {
  projects: [{ id: 'vitest:web', framework: 'vitest', root: 'web', label: 'web' }],
  tree: [
    node({
      id: 'vitest:web',
      kind: 'project',
      name: 'web',
      children: [
        node({
          id: 'f1',
          kind: 'file',
          name: 'cart.test.ts',
          file: 'web/cart.test.ts',
          children: [
            node({
              id: 's1',
              kind: 'suite',
              name: 'cart',
              file: 'web/cart.test.ts',
              path: ['cart'],
              line: 3,
              children: [
                node({
                  id: 't1',
                  kind: 'test',
                  name: 'adds an item',
                  file: 'web/cart.test.ts',
                  path: ['cart', 'adds an item'],
                  line: 4,
                }),
                node({
                  id: 't2',
                  kind: 'test',
                  name: 'empties',
                  file: 'web/cart.test.ts',
                  path: ['cart', 'empties'],
                  line: 9,
                }),
              ],
            }),
          ],
        }),
        node({ id: 'f2', kind: 'file', name: 'empty.test.ts', file: 'web/empty.test.ts' }),
      ],
    }),
  ],
  truncated: false,
};

const snapshot: TestRunSnapshot = {
  summary: {
    runId: 'r1',
    projectId: 'p1',
    startedAt: Date.parse('2026-11-01T10:00:00Z'),
    finishedAt: Date.parse('2026-11-01T10:00:05Z'),
    running: false,
    cancelled: false,
    passed: 1,
    failed: 1,
    skipped: 0,
    commands: ['npx vitest run'],
    errors: [],
  },
  results: [
    {
      id: 't1',
      testProjectId: 'vitest:web',
      file: 'web/cart.test.ts',
      path: ['cart', 'adds an item'],
      status: 'passed',
    },
    {
      id: 't2',
      testProjectId: 'vitest:web',
      file: 'web/cart.test.ts',
      path: ['cart', 'empties'],
      line: 9,
      status: 'failed',
      message: 'expected 0 to be 1',
      stack: 'at cart.test.ts:10',
    },
  ],
  output: `${'x'.repeat(5000)}END`,
  queued: ['t1', 't2'],
};

const runner = vi.hoisted(() => ({
  last: null as TestRunSnapshot | null,
  idle: Promise.resolve() as Promise<void>,
  start: vi.fn(async (_projectId: string, _targets: unknown) => ({})),
  cancel: vi.fn((_projectId: string) => true),
}));

vi.mock('../../ipc/tests', () => ({
  discoverProjectTests: async () => discovery,
  startTestRun: runner.start,
  cancelTestRun: runner.cancel,
  lastTestRun: () => runner.last,
  whenTestRunIdle: () => runner.idle,
}));

/** Test tools: what the Tests panel found, the last run's results, and running tests. */

const userData = useTempUserData();
const context: ToolContext = {
  projectId: 'p1',
  callerKind: 'runova',
  agent: 'Claude Code',
  cwd: null,
};
let tools: Map<string, AiTool>;

beforeEach(async () => {
  runner.last = null;
  runner.idle = Promise.resolve();
  runner.start.mockClear();
  runner.cancel.mockClear();
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: 'C:/code/shop', createdAt: '2026-01-01T00:00:00Z' },
  ]);
  const { testTools } = await import('./tests');
  tools = new Map(testTools.map((tool) => [tool.name, tool]));
});

async function run(name: string, args: Record<string, unknown> = {}) {
  const tool = tools.get(name) as AiTool;
  return tool.run(tool.input.parse(args), context);
}

describe('test tools', () => {
  it('lists test projects with their files, and the tests in one file', async () => {
    expect((await run('tests_list')).data).toEqual({
      truncated: false,
      projects: [
        {
          id: 'vitest:web',
          framework: 'vitest',
          label: 'web',
          root: 'web',
          files: [
            { file: 'web/cart.test.ts', tests: 2 },
            { file: 'web/empty.test.ts', tests: 0 },
          ],
        },
      ],
    });
    expect((await run('tests_list', { file: 'web/cart.test.ts' })).data).toEqual({
      file: 'web/cart.test.ts',
      testProjectId: 'vitest:web',
      tests: [
        { path: ['cart', 'adds an item'], line: 4 },
        { path: ['cart', 'empties'], line: 9 },
      ],
    });
    await expect(run('tests_list', { file: 'web/nope.test.ts' })).rejects.toThrow(/No test file/);
  });

  it('gives the last run with its failures and the end of its output', async () => {
    expect((await run('tests_results')).text).toMatch(/No tests have run/);
    runner.last = snapshot;
    const data = (await run('tests_results', { outputChars: 100 })).data as Record<string, unknown>;
    expect(data).toMatchObject({
      runId: 'r1',
      running: false,
      passed: 1,
      failed: 1,
      failures: [
        {
          file: 'web/cart.test.ts',
          test: 'cart > empties',
          line: 9,
          message: 'expected 0 to be 1',
        },
      ],
    });
    expect((data.output as string).length).toBe(100);
    expect(data.output).toMatch(/END$/);
  });

  it('runs everything, or the picked files and tests under the project that owns them', async () => {
    runner.last = snapshot;
    const all = await run('tests_run');
    expect(runner.start).toHaveBeenLastCalledWith('p1', []);
    expect(all.data).toMatchObject({ runId: 'r1', failed: 1 });

    await run('tests_run', {
      files: ['web/empty.test.ts'],
      tests: [{ file: 'web/cart.test.ts', path: ['cart', 'empties'] }],
    });
    expect(runner.start).toHaveBeenLastCalledWith('p1', [
      {
        testProjectId: 'vitest:web',
        files: ['web/empty.test.ts'],
        tests: [{ file: 'web/cart.test.ts', path: ['cart', 'empties'] }],
      },
    ]);

    await expect(run('tests_run', { files: ['src/other.test.ts'] })).rejects.toThrow(
      /src\/other\.test\.ts/,
    );
  });

  it('returns while a long run is still going, and cancels it', async () => {
    runner.last = { ...snapshot, summary: { ...snapshot.summary, running: true } };
    // A run that never ends, so the tool has to stop waiting on its own.
    runner.idle = new Promise(() => undefined);
    const result = await run('tests_run', { waitSeconds: 0 });
    expect(result.data).toMatchObject({ running: true });
    await run('tests_cancel');
    expect(runner.cancel).toHaveBeenCalledWith('p1');
    runner.cancel.mockReturnValueOnce(false);
    await expect(run('tests_cancel')).rejects.toThrow(/No tests are running/);
  });
});
