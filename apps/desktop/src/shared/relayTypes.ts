import type {
  AwaitReason,
  LegPhase,
  ProposalEntry,
  RelayAfterPlanMode,
  RelayFinished,
  RelayHandoff,
  RelayIssue,
  RelayItem,
  RelayItemKind,
  RelayLegRecord,
  RelayOptions,
  RelayOutcome,
  RelayPlan,
  RelayPriority,
  RelayProposal,
  RelayRunChoice,
  RelaySize,
  RelayTask,
  RelayTaskOverride,
  RelayTaskStatus,
  RelayTestResult,
  RelayTrigger,
} from '@runova/core';

/**
 * Relay (E26): the contract between main, the preload and the renderer. Task and handoff files live
 * in the project; main reads them, runs the relays and owns `relay.json` in userData. Only ids and
 * plain data cross the boundary, never a command line.
 */

/** A project's relay choices: the run choice for every task, per-task overrides and options. */
export interface RelayProjectSettings {
  /** Project-relative docs folder whose `tasks/` holds the board. */
  docsFolder: string;
  defaults: RelayRunChoice;
  overrides: Record<string, RelayTaskOverride>;
  options: RelayOptions;
}

export type RelaySettingsPatch = Partial<Omit<RelayProjectSettings, 'options' | 'defaults'>> & {
  defaults?: Partial<RelayRunChoice>;
  options?: Partial<RelayOptions>;
};

/** What the board shows of a handoff without opening it. */
export interface RelayHandoffSummary {
  outcome: RelayOutcome | null;
  tests: RelayTestResult | null;
  leg: number | null;
  updated: string | null;
  missingSections: RelayHandoff['missingSections'];
  /** The Next step section, trimmed for a card. */
  next: string;
}

/** A task as the board lists it: the parsed file without its body. */
export type RelayTaskCard = Omit<RelayTask, 'body'> & {
  handoff: RelayHandoffSummary | null;
  /** Sessions run on this task so far, across relays and single runs. */
  legCount: number;
  /**
   * The most context each of those sessions held, oldest first, to set against the estimate.
   * Sessions with no reading (quiet detection, a CLI without a transcript) are left out.
   */
  legPeaks: number[];
};

export interface RelayBoard {
  projectId: string;
  docsFolder: string;
  /** The tasks folder exists. When false the board offers to start one. */
  exists: boolean;
  guidePresent: boolean;
  tasks: RelayTaskCard[];
  /** Task ids in run order. */
  order: string[];
  cycles: string[][];
  missing: { taskId: string; dependsOn: string }[];
  /** Problems with the folder as a whole, such as two files with one id. */
  issues: RelayIssue[];
  settings: RelayProjectSettings;
  /** The relay running, waiting or paused on this project, if any. */
  active: RelayRunView | null;
}

export interface RelayTaskDetail {
  task: RelayTask;
  handoff: RelayHandoff | null;
  /** The raw handoff file, for the baton view. */
  handoffText: string | null;
  legs: RelayLegRecord[];
}

/** The live state of a relay's current leg, for the track, the fuel ring and the status bar. */
export interface RelayLegView {
  legId: string;
  taskId: string;
  legNo: number;
  phase: LegPhase;
  tabId: string | null;
  choice: RelayRunChoice;
  planFirst: boolean;
  startedAt: number;
  contextTokens: number | null;
  peakContextTokens: number | null;
  budget: number;
  /** Where the context guard fires, when the CLI has one. */
  guardAt: number | null;
  awaiting: { reason: AwaitReason; message: string } | null;
}

export interface RelayRunView {
  id: string;
  projectId: string;
  status: 'waiting' | 'running' | 'paused' | 'done' | 'cancelled';
  trigger: RelayTrigger;
  /** "Starts when T004 is done", worded in main. */
  triggerText: string;
  queue: string[];
  finished: RelayFinished[];
  current: RelayLegView | null;
  pauseReason: string | null;
  options: RelayOptions;
  createdAt: number;
}

export interface RelayStartInput {
  projectId: string;
  /** Run only these tasks (any status), in dependency order. */
  only?: string[];
  /** Start at this task and run what follows it. */
  from?: string;
  trigger: RelayTrigger;
  /** Changes for this relay only, on top of the project's settings. */
  options?: Partial<RelayOptions>;
  defaults?: Partial<RelayRunChoice>;
}

export type RelayStartResult = { ok: true; run: RelayRunView } | { ok: false; error: string };

/** A single task run in a new session, started by hand: the prompt to paste and the run choice. */
export interface RelaySingleRun {
  prompt: string;
  choice: RelayRunChoice;
  planFirst: boolean;
  legNo: number;
}

export interface RelayPlannerInput {
  /** Lets cancelPlanner(requestId) stop the run. */
  requestId: string;
  projectId: string;
  cliId?: string | null;
  model?: string | null;
  effort?: string | null;
  budget?: number;
  /** Tasks may be bigger than one session: they roll on to fresh sessions until done. */
  keepRolling?: boolean;
}

export interface RelayDecomposeInput extends RelayPlannerInput {
  request: string;
  /** `plan` breaks the job into specced parts with no context budget (E121). */
  mode?: RelayPlanModeChoice;
}

export interface RelayReviseInput extends RelayPlannerInput {
  note?: string;
}

/** Catching up a project already under way: what is done, half done and left, as tasks. */
export interface RelayCatchUpInput extends RelayPlannerInput {
  /** Put finished work on the board as done tasks. */
  recordDone: boolean;
  /** What the user says about the project, such as where its plan is. */
  note?: string;
}

export type RelayPlannerResult =
  | {
      ok: true;
      proposal: RelayProposal;
      /** What the proposal would do, with the ids it would really get. */
      entries: ProposalEntry[];
      cliName: string | null;
    }
  | { ok: false; error: string; cancelled?: boolean };

export interface RelayApplyResult {
  written: string[];
  removed: string[];
  /** Milestone, risk and question files written (E121). */
  items?: string[];
  /** PLAN.md was written or its mode changed. */
  plan?: boolean;
  warnings: string[];
}

/** Plan mode (E121): how a split is sized. */
export type RelayPlanModeChoice = 'fit' | 'plan';

/** Runs one task, some tasks or every unfinished task again, as a new attempt. */
export interface RelayRedoInput {
  projectId: string;
  /** The tasks to redo; `all` is every task that is not done. */
  taskIds: string[] | 'all';
  /** The CLI the new attempt runs with. Null keeps each task's own. */
  agent: string | null;
  /** The new attempt reads what the earlier one learned; off, it starts from the spec alone. */
  keepLearnings: boolean;
  /** Start the redone tasks now. */
  start: boolean;
}

export interface RelayRedoResult {
  redone: string[];
  warnings: string[];
  started: boolean;
  error?: string;
}

/** A proposal an agent sent through the MCP bridge, waiting for the user in the app. */
export interface RelayMcpProposal {
  id: string;
  projectId: string;
  projectName: string;
  /** The task whose session sent it, when a relay leg did. */
  fromTaskId: string | null;
  proposal: RelayProposal;
  entries: ProposalEntry[];
  receivedAt: number;
}

export interface RelayChangedEvent {
  projectId: string;
  /** What changed: the files, the run, or both. */
  reason: 'files' | 'run' | 'settings';
}

export interface RelayContextEvent {
  projectId: string;
  tabId: string;
  taskId: string;
  tokens: number;
  budget: number;
  guardAt: number | null;
}

/** Main asks the renderer to show a leg's session as a tab of its project's workspace. */
export interface RelayLegTabEvent {
  projectId: string;
  tabId: string;
  legId: string;
  cliId: string;
  title: string;
  runLabel?: string;
  cwd: string;
}

export interface RelayCloseTabEvent {
  projectId: string;
  tabId: string;
}

export type { RelayAfterPlanMode, RelayTaskStatus };

/** The plan around the tasks (E122): PLAN.md and every record, for the Tasks views. */
export interface RelayPlanPack {
  plan: RelayPlan | null;
  items: Record<RelayItemKind, RelayItem[]>;
}

/** Front matter changes to one task. Null or empty removes the field. */
export interface RelayTaskPatch {
  title?: string;
  epic?: string | null;
  priority?: RelayPriority | null;
  size?: RelaySize | null;
  milestone?: string | null;
  labels?: string[];
  agent?: string | null;
  due?: string | null;
  estimate?: number | null;
  budget?: number | null;
  depends?: string[];
}

/** A task added by hand. */
export interface RelayTaskInput {
  title: string;
  epic?: string | null;
  depends?: string[];
  priority?: RelayPriority | null;
  size?: RelaySize | null;
  milestone?: string | null;
  labels?: string[];
  agent?: string | null;
  due?: string | null;
  goal?: string;
  scope?: string;
  acceptance?: string[];
  testPlan?: string;
}

/** Changes to PLAN.md, or what a new one holds. */
export interface RelayPlanInput {
  title?: string;
  mode?: RelayPlanModeChoice;
  budget?: number | null;
  keepRolling?: boolean;
  runPastBudget?: boolean;
  reviewEachTask?: boolean;
  definitionOfDone?: string[];
  goal?: string;
  outOfScope?: string;
}

/** A record to add (no id) or change (with its id). */
export interface RelayItemInput {
  kind: RelayItemKind;
  id?: string;
  title?: string;
  status?: string;
  fields?: Partial<
    Record<
      | 'task'
      | 'owner'
      | 'target'
      | 'dependency'
      | 'ecosystem'
      | 'waitingFor'
      | 'revisitBy'
      | 'likelihood'
      | 'impact',
      string | null
    >
  >;
  /** Section text by heading, such as `{ Decision: '...' }`. */
  sections?: Record<string, string>;
}
