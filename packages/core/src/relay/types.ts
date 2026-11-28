/**
 * Relay (E26): tasks sized to fit one agent session, run one after another, each session handing
 * the next a written baton. Tasks and handoffs are Markdown files in the project (the SDD source of
 * truth); these are the shapes the app reads them into.
 */

export const RELAY_TASK_STATUSES = ['todo', 'in-progress', 'testing', 'done', 'blocked'] as const;
/** A task's column on the board. The app writes it; agents only ever write handoffs. */
export type RelayTaskStatus = (typeof RELAY_TASK_STATUSES)[number];

export const RELAY_OUTCOMES = ['done', 'continue', 'blocked'] as const;
/**
 * How a session left its task: finished, out of context budget (a fresh session picks it up from
 * the handoff), or stuck on something only the user can answer.
 */
export type RelayOutcome = (typeof RELAY_OUTCOMES)[number];

export const RELAY_TEST_RESULTS = ['passed', 'failed', 'not-run'] as const;
export type RelayTestResult = (typeof RELAY_TEST_RESULTS)[number];

export type HandoffSectionKey =
  | 'purpose'
  | 'done'
  | 'decisions'
  | 'tests'
  | 'workarounds'
  | 'rejected'
  | 'questions'
  | 'next';

/** How urgent a task is, p0 first. Optional: a task without one sorts after those with one. */
export const RELAY_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type RelayPriority = (typeof RELAY_PRIORITIES)[number];

/** A rough size for planning, used in plan mode where context budgets do not apply. */
export const RELAY_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type RelaySize = (typeof RELAY_SIZES)[number];

/** Something in a file that was read past rather than trusted. Shown on the card. */
export interface RelayIssue {
  field: string;
  message: string;
}

export interface RelayTask {
  id: string;
  title: string;
  status: RelayTaskStatus;
  /** A group label such as `E02`, used for the card's color and the board filter. */
  epic: string | null;
  order: number | null;
  depends: string[];
  /** The planner's guess at the context one session needs. Advisory; the live meter decides. */
  estimate: number | null;
  /** Context tokens one session may use on this task. Null means the relay's default. */
  budget: number | null;
  /** The docs this task implements, relative to the project. */
  specs: string[];
  priority: RelayPriority | null;
  size: RelaySize | null;
  /** The milestone (M###) the task belongs to. */
  milestone: string | null;
  labels: string[];
  /** The CLI the task should run with, such as `codex-cli`. Null means the relay's choice. */
  agent: string | null;
  /** A date the task is due, as written (`2026-12-01`). */
  due: string | null;
  /** How many times the task has been started over, from 1. A redo raises it. */
  attempt: number | null;
  /** A redo that keeps what was learned: the earlier attempt this one reads first. */
  learnFrom: number | null;
  /** When the first session started and when the task was done, written by Runova. */
  started: string | null;
  finished: string | null;
  /** File name inside the tasks folder. */
  file: string;
  /** Everything after the front matter. */
  body: string;
  acceptance: { checked: number; total: number };
  issues: RelayIssue[];
}

/** What a planner (or the user) fills in for a new task file. */
export interface RelayTaskDraft {
  id: string;
  title: string;
  status?: RelayTaskStatus;
  epic?: string | null;
  order?: number | null;
  depends?: string[];
  estimate?: number | null;
  budget?: number | null;
  specs?: string[];
  priority?: RelayPriority | null;
  size?: RelaySize | null;
  milestone?: string | null;
  labels?: string[];
  agent?: string | null;
  due?: string | null;
  goal?: string;
  /** Plan mode writes a fuller spec: background, approach and the files and interfaces touched. */
  context?: string;
  approach?: string;
  interfaces?: string;
  scope?: string;
  outOfScope?: string;
  acceptance?: string[];
  testPlan?: string;
  risks?: string;
}

export interface RelayHandoff {
  taskId: string;
  outcome: RelayOutcome | null;
  tests: RelayTestResult | null;
  leg: number | null;
  updated: string | null;
  sections: Record<HandoffSectionKey, string>;
  /**
   * Sections that need filling in, in template order: the first five when absent or empty, and
   * Tests run, Workarounds and Open questions when their heading is there but empty. A handoff
   * written before those three existed has no heading for them and is not asked for them.
   */
  missingSections: HandoffSectionKey[];
  issues: RelayIssue[];
}
