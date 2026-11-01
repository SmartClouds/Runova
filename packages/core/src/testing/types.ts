/**
 * Shared shapes for the workspace Tests panel. Discovery, runs and results all speak in these, so
 * the main process, the renderer and every framework adapter agree on what a test is.
 */

export type TestFrameworkId =
  | 'vitest'
  | 'jest'
  | 'playwright'
  | 'mocha'
  | 'pytest'
  | 'unittest'
  | 'go'
  | 'cargo'
  | 'dotnet'
  | 'dart'
  | 'flutter'
  | 'phpunit'
  | 'rspec'
  | 'gradle'
  | 'maven';

/** One runnable test setup: a framework rooted at a folder inside the workspace. */
export interface TestProject {
  /** `framework:root`, stable across discoveries. */
  id: string;
  framework: TestFrameworkId;
  /** Folder relative to the workspace, posix separators, `''` for the workspace itself. */
  root: string;
  label: string;
  /** Framework specific facts read from the manifest, such as a Go module path. */
  meta?: Record<string, string>;
}

export type TestNodeKind = 'project' | 'file' | 'suite' | 'test';

export interface TestNode {
  id: string;
  kind: TestNodeKind;
  name: string;
  testProjectId: string;
  /** Workspace relative, posix separators. Unset on project nodes. */
  file?: string;
  /** 1-based line where the test or suite is declared, when known. */
  line?: number;
  /** Suite names down to this node, including its own name. Empty for files and projects. */
  path: string[];
  /** Framework specific name used to select just this test, like a pytest node id. */
  selector?: string;
  children: TestNode[];
}

/** A test found by reading source, before anything has been run. */
export interface DiscoveredTest {
  path: string[];
  line: number;
  kind: 'suite' | 'test';
  selector?: string;
}

export type TestStatus = 'queued' | 'running' | 'passed' | 'failed' | 'skipped';

/** One result as a framework reported it, before it is matched to a discovered test. */
export interface ParsedTestResult {
  /** As reported: absolute, or relative to the test project root. */
  file?: string;
  /** Folder the test lives in, relative to the project root, when the report names no file. */
  dir?: string;
  path: string[];
  status: Exclude<TestStatus, 'queued' | 'running'>;
  durationMs?: number;
  message?: string;
  stack?: string;
  line?: number;
  /** Framework specific full name, compared with a discovered test's selector. */
  selector?: string;
  /** Suite and test names joined with spaces, for reports that do not split them. */
  fullName?: string;
}

export interface TestResult {
  id: string;
  testProjectId: string;
  file?: string;
  path: string[];
  line?: number;
  status: TestStatus;
  durationMs?: number;
  message?: string;
  stack?: string;
}

export interface TestRef {
  file: string;
  path: string[];
  selector?: string;
  line?: number;
}

/** What to run inside one test project. No files and no tests means everything. */
export interface TestTarget {
  testProjectId: string;
  files?: string[];
  tests?: TestRef[];
}

export interface TestDiscovery {
  projects: TestProject[];
  /** One project node per test project, files and suites below. */
  tree: TestNode[];
  /** True when the file cap was hit and some tests may be missing. */
  truncated: boolean;
}

export type TestRunErrorKind = 'notFound' | 'noResults' | 'timedOut' | 'failedToStart';

export interface TestRunError {
  kind: TestRunErrorKind;
  testProjectId: string;
  command: string;
  message: string;
  log: string;
  /**
   * Set when the run broke after it had reported some results: the files and tests it never got
   * to. Running those again, with the failures, finishes the job without repeating every test
   * that already passed. Absent when nothing was reported, so the whole test project runs again.
   */
  unfinished?: { files: string[]; tests: TestRef[] };
}

export interface TestRunSummary {
  runId: string;
  projectId: string;
  startedAt: number;
  finishedAt?: number;
  running: boolean;
  cancelled: boolean;
  passed: number;
  failed: number;
  skipped: number;
  /** The commands the run started, one per test project. */
  commands: string[];
  errors: TestRunError[];
}

export type TestRunEvent =
  | { type: 'started'; runId: string; projectId: string; summary: TestRunSummary; queued: string[] }
  | { type: 'output'; runId: string; projectId: string; text: string }
  | { type: 'results'; runId: string; projectId: string; results: TestResult[] }
  | { type: 'done'; runId: string; projectId: string; summary: TestRunSummary };

/** Everything the panel needs to redraw the last run after a reload or a project switch. */
export interface TestRunSnapshot {
  summary: TestRunSummary;
  results: TestResult[];
  output: string;
  /**
   * The tests this run picked, so a panel that reopens mid-run can show the ones still waiting as
   * running again. Results only cover what the runner has reported so far.
   */
  queued: string[];
}
