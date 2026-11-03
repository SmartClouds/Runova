import type { TestNode, TestRunSnapshot, TestTarget } from '@runova/core';
import { z } from 'zod';
import {
  cancelTestRun,
  discoverProjectTests,
  lastTestRun,
  startTestRun,
  whenTestRunIdle,
} from '../../ipc/tests';
import { defineTool } from '../registry';
import { projectIdArg, projectIdOf, projectOf } from './shared';

/**
 * Test tools: the tests the Tests panel finds, the results of the last run, and running or
 * cancelling tests. A run goes through the panel's own runner, so the panel shows it live and
 * keeps its results.
 */

const MAX_FAILURES = 50;
const MAX_STACK = 3_000;
const MAX_ERROR_LOG = 2_000;

function tail(text: string, chars: number): string {
  return chars <= 0 ? '' : text.slice(-chars);
}

function walk(entry: TestNode, visit: (node: TestNode) => void): void {
  visit(entry);
  for (const child of entry.children) walk(child, visit);
}

/** The test project node that owns a file, and the file's own node. */
function ownerOf(tree: TestNode[], file: string): { project: TestNode; file: TestNode } | null {
  for (const project of tree) {
    const found: TestNode[] = [];
    walk(project, (entry) => {
      if (entry.kind === 'file' && entry.file === file) found.push(entry);
    });
    if (found[0]) return { project, file: found[0] };
  }
  return null;
}

function testsIn(entry: TestNode): TestNode[] {
  const tests: TestNode[] = [];
  walk(entry, (one) => {
    if (one.kind === 'test') tests.push(one);
  });
  return tests;
}

function runShape(snapshot: TestRunSnapshot, outputChars: number) {
  const { summary } = snapshot;
  const failures = snapshot.results.filter((result) => result.status === 'failed');
  const reported = new Set(snapshot.results.map((result) => result.id));
  return {
    runId: summary.runId,
    running: summary.running,
    cancelled: summary.cancelled,
    startedAt: new Date(summary.startedAt).toISOString(),
    finishedAt: summary.finishedAt ? new Date(summary.finishedAt).toISOString() : null,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    waiting: summary.running ? snapshot.queued.filter((id) => !reported.has(id)).length : 0,
    commands: summary.commands,
    errors: summary.errors.map((error) => ({
      kind: error.kind,
      testProjectId: error.testProjectId,
      command: error.command,
      message: error.message,
      log: tail(error.log, MAX_ERROR_LOG),
    })),
    failuresShown: Math.min(failures.length, MAX_FAILURES),
    failures: failures.slice(0, MAX_FAILURES).map((result) => ({
      file: result.file ?? null,
      test: result.path.join(' > '),
      line: result.line ?? null,
      message: result.message ?? null,
      stack: result.stack ? result.stack.slice(0, MAX_STACK) : null,
    })),
    output: tail(snapshot.output, outputChars),
  };
}

const outputCharsArg = z
  .number()
  .int()
  .min(0)
  .max(20_000)
  .default(2_000)
  .describe('How much of the end of the run output to include.');

const testRefArg = z.object({
  file: z.string().min(1).describe('The file, as tests_list shows it.'),
  path: z
    .array(z.string())
    .min(1)
    .describe('Suite names down to the test, ending with its name, as tests_list shows them.'),
});

/** Puts picked files and tests under the test project that owns each, as the runner wants them. */
function targetsFor(
  tree: TestNode[],
  files: string[],
  tests: z.infer<typeof testRefArg>[],
): TestTarget[] {
  const byProject = new Map<string, Required<TestTarget>>();
  const unknown: string[] = [];
  const targetOf = (file: string) => {
    const owner = ownerOf(tree, file);
    if (!owner) {
      unknown.push(file);
      return null;
    }
    const id = owner.project.id;
    let target = byProject.get(id);
    if (!target) {
      target = { testProjectId: id, files: [], tests: [] };
      byProject.set(id, target);
    }
    return target;
  };
  for (const file of files) targetOf(file)?.files.push(file);
  for (const ref of tests) targetOf(ref.file)?.tests.push({ file: ref.file, path: ref.path });
  if (unknown.length > 0) {
    throw new Error(
      `Runova found no tests in ${[...new Set(unknown)].join(', ')}. tests_list shows the files it knows.`,
    );
  }
  return [...byProject.values()].map((target) => ({
    testProjectId: target.testProjectId,
    ...(target.files.length > 0 ? { files: target.files } : {}),
    ...(target.tests.length > 0 ? { tests: target.tests } : {}),
  }));
}

export const testTools = [
  defineTool({
    name: 'tests_list',
    area: 'tests',
    title: 'List tests',
    description:
      "The project's test setups (Vitest, Jest, pytest, Go and others) with their test files and how many tests each holds, as the Tests panel finds them. Pass file to get the tests in that file, to pick them for tests_run.",
    risk: 'read',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      file: z.string().min(1).optional().describe('A test file from the list.'),
    }),
    preview: (args) => ({ title: args.file ? `List the tests in ${args.file}` : 'List the tests' }),
    async run(args, context) {
      const discovery = await discoverProjectTests(projectIdOf(context));
      if (args.file) {
        const owner = ownerOf(discovery.tree, args.file);
        if (!owner) throw new Error(`No test file ${args.file}. Call tests_list without file.`);
        return {
          data: {
            file: args.file,
            testProjectId: owner.project.id,
            tests: testsIn(owner.file).map((test) => ({
              path: test.path,
              line: test.line ?? null,
            })),
          },
        };
      }
      return {
        data: {
          truncated: discovery.truncated,
          projects: discovery.projects.map((project) => {
            const tree = discovery.tree.find((entry) => entry.id === project.id);
            const files: { file: string; tests: number }[] = [];
            if (tree) {
              walk(tree, (entry) => {
                if (entry.kind === 'file' && entry.file) {
                  files.push({ file: entry.file, tests: testsIn(entry).length });
                }
              });
            }
            return {
              id: project.id,
              framework: project.framework,
              label: project.label,
              root: project.root,
              files,
            };
          }),
        },
      };
    },
  }),

  defineTool({
    name: 'tests_results',
    area: 'tests',
    title: 'Test results',
    description:
      "The project's current or last test run as the Tests panel shows it: counts, the failures with their messages and stacks, errors that kept a test setup from running, and the end of the output.",
    risk: 'read',
    needsProject: true,
    input: z.object({ projectId: projectIdArg, outputChars: outputCharsArg }),
    preview: () => ({ title: 'Read the test results' }),
    async run(args, context) {
      const snapshot = lastTestRun(projectIdOf(context));
      if (!snapshot) {
        return { text: 'No tests have run on this project since Runova started. Use tests_run.' };
      }
      return { data: runShape(snapshot, args.outputChars) };
    },
  }),

  defineTool({
    name: 'tests_run',
    area: 'tests',
    title: 'Run tests',
    description:
      'Runs the project tests with the Tests panel runner: everything, one test setup, or picked files and tests from tests_list. Waits up to waitSeconds (60 by default) and returns the results; a run still going then keeps going, and tests_results reads it later.',
    risk: 'sensitive',
    needsProject: true,
    input: z.object({
      projectId: projectIdArg,
      testProjectId: z
        .string()
        .min(1)
        .optional()
        .describe('Run only this test setup, by its id from tests_list.'),
      files: z.array(z.string().min(1)).max(500).optional(),
      tests: z.array(testRefArg).max(500).optional(),
      waitSeconds: z.number().int().min(0).max(600).default(60),
      outputChars: outputCharsArg,
    }),
    async preview(args, context) {
      const project = await projectOf(context);
      const picked = [
        ...(args.files ?? []),
        ...(args.tests ?? []).map((ref) => `${ref.file}: ${ref.path.join(' > ')}`),
      ];
      return {
        title: `Run tests in ${project.name}`,
        fields: [
          {
            label: 'What',
            value:
              picked.length > 0
                ? picked.slice(0, 20).join('\n') +
                  (picked.length > 20 ? `\nand ${picked.length - 20} more` : '')
                : (args.testProjectId ?? 'Every test'),
            mono: picked.length > 0 || args.testProjectId !== undefined,
          },
        ],
      };
    },
    async run(args, context) {
      const projectId = projectIdOf(context);
      const files = args.files ?? [];
      const tests = args.tests ?? [];
      let targets: TestTarget[] = [];
      if (files.length > 0 || tests.length > 0) {
        targets = targetsFor((await discoverProjectTests(projectId)).tree, files, tests);
      } else if (args.testProjectId) {
        targets = [{ testProjectId: args.testProjectId }];
      }
      await startTestRun(projectId, targets);

      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        whenTestRunIdle(projectId),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, args.waitSeconds * 1000);
        }),
      ]);
      clearTimeout(timer);

      const snapshot = lastTestRun(projectId);
      if (!snapshot) return { text: 'The run started. tests_results shows how it goes.' };
      return { data: runShape(snapshot, args.outputChars) };
    },
  }),

  defineTool({
    name: 'tests_cancel',
    area: 'tests',
    title: 'Cancel the test run',
    description: 'Cancels the test run going on the project, as the Tests panel Stop button does.',
    risk: 'write',
    needsProject: true,
    input: z.object({ projectId: projectIdArg }),
    preview: () => ({ title: 'Cancel the running tests' }),
    async run(_args, context) {
      if (!cancelTestRun(projectIdOf(context))) {
        throw new Error('No tests are running on this project.');
      }
      return { text: 'Cancelled the test run.' };
    },
  }),
];
