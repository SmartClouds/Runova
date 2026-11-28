import { stringify as stringifyYaml } from 'yaml';
import { RELAY_TASKS_DIR, taskFileName } from './format.js';
import {
  frontMatterList,
  frontMatterText,
  readChoice,
  splitFrontMatter,
  yamlScalar,
} from './parse.js';
import type { RelayIssue, RelayOutcome, RelayTestResult } from './types.js';

/**
 * The plan pack (E121): everything around the tasks that a project manager keeps, as Markdown in
 * the tasks folder so git keeps its history. PLAN.md holds the plan and its settings; milestones,
 * decisions, workarounds, risks and questions are one file each; every task has a journal of the
 * sessions that worked on it. All of it reads leniently: a bad value becomes an issue, not an error.
 */

export const RELAY_PLAN_FILE = 'PLAN.md';
export const RELAY_JOURNAL_DIR = 'journal';
/** Under the handoffs folder: the handoffs and journals of attempts that were started over. */
export const RELAY_ARCHIVE_DIR = 'archive';

export const RELAY_PLAN_MODES = ['fit', 'plan'] as const;
/**
 * `fit` sizes tasks to a context budget, as Relay always has. `plan` breaks a job into parts by
 * what can be built and tested on its own, with no budget at all.
 */
export type RelayPlanMode = (typeof RELAY_PLAN_MODES)[number];

export interface RelayPlan {
  title: string;
  mode: RelayPlanMode;
  /** Context tokens per session in fit mode. Null means the project's default. */
  budget: number | null;
  keepRolling: boolean;
  runPastBudget: boolean;
  /** Pause after every finished task so the person can look before the next one starts. */
  reviewEachTask: boolean;
  definitionOfDone: string[];
  body: string;
  issues: RelayIssue[];
}

export interface RelayPlanDraft {
  title: string;
  mode?: RelayPlanMode;
  budget?: number | null;
  keepRolling?: boolean;
  runPastBudget?: boolean;
  reviewEachTask?: boolean;
  definitionOfDone?: string[];
  goal?: string;
  background?: string;
  outOfScope?: string;
  conventions?: string;
}

function flag(value: unknown, field: string, issues: RelayIssue[]): boolean {
  if (value == null || value === '') return false;
  if (typeof value === 'boolean') return value;
  const word = frontMatterText(value)?.toLowerCase();
  if (word === 'true' || word === 'yes' || word === 'on') return true;
  if (word === 'false' || word === 'no' || word === 'off') return false;
  issues.push({ field, message: `"${frontMatterText(value)}" is not true or false.` });
  return false;
}

function count(value: unknown, field: string, issues: RelayIssue[]): number | null {
  if (value == null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(frontMatterText(value));
  if (!Number.isInteger(number) || number <= 0) {
    issues.push({ field, message: `"${frontMatterText(value)}" is not a whole number.` });
    return null;
  }
  return number;
}

export function parsePlanFile(content: string): RelayPlan {
  const { data, body, issue } = splitFrontMatter(content);
  const issues: RelayIssue[] = issue ? [issue] : [];
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  return {
    title: frontMatterText(data.title) ?? heading ?? 'Plan',
    mode:
      readChoice('mode', data.mode, RELAY_PLAN_MODES, { budget: 'fit', parts: 'plan' }, issues) ??
      'fit',
    budget: count(data.budget, 'budget', issues),
    keepRolling: flag(data.keepRolling, 'keepRolling', issues),
    runPastBudget: flag(data.runPastBudget, 'runPastBudget', issues),
    reviewEachTask: flag(data.reviewEachTask, 'reviewEachTask', issues),
    definitionOfDone: frontMatterList(data.definitionOfDone),
    body,
    issues,
  };
}

export function renderPlanFile(draft: RelayPlanDraft): string {
  const front = [`title: ${yamlScalar(draft.title)}`, `mode: ${draft.mode ?? 'fit'}`];
  if (draft.budget != null) front.push(`budget: ${draft.budget}`);
  front.push(`keepRolling: ${draft.keepRolling === true}`);
  front.push(`runPastBudget: ${draft.runPastBudget === true}`);
  front.push(`reviewEachTask: ${draft.reviewEachTask === true}`);
  const done = (draft.definitionOfDone ?? []).map((item) => item.trim()).filter(Boolean);
  if (done.length > 0)
    front.push('definitionOfDone:', ...done.map((item) => `  - ${yamlScalar(item)}`));

  const sections = [`# ${draft.title.trim()}`];
  const section = (heading: string, value: string | undefined): void => {
    if (value?.trim()) sections.push(`## ${heading}\n\n${value.trim()}`);
  };
  section('Goal', draft.goal);
  section('Background', draft.background);
  if (done.length > 0) {
    sections.push(`## Definition of done\n\n${done.map((item) => `- ${item}`).join('\n')}`);
  }
  section('Out of scope', draft.outOfScope);
  section('Conventions', draft.conventions);
  return `---\n${front.join('\n')}\n---\n\n${sections.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Items: milestones, decisions, workarounds, risks and questions
// ---------------------------------------------------------------------------------------------

export const RELAY_ITEM_KINDS = [
  'milestone',
  'decision',
  'workaround',
  'risk',
  'question',
] as const;
export type RelayItemKind = (typeof RELAY_ITEM_KINDS)[number];

export const RELAY_LEVELS = ['low', 'medium', 'high'] as const;
export type RelayLevel = (typeof RELAY_LEVELS)[number];

export interface RelayItemKindSpec {
  kind: RelayItemKind;
  /** The letter its ids start with: M001, D001, W001, R001, Q001. */
  prefix: string;
  /** Folder inside the tasks folder. */
  folder: string;
  label: string;
  plural: string;
  statuses: readonly string[];
  /** The sections a new file gets, in order, with what each is for. */
  sections: readonly { heading: string; hint: string }[];
}

export const RELAY_ITEM_SPECS: Record<RelayItemKind, RelayItemKindSpec> = {
  milestone: {
    kind: 'milestone',
    prefix: 'M',
    folder: 'milestones',
    label: 'Milestone',
    plural: 'Milestones',
    statuses: ['planned', 'active', 'done'],
    sections: [
      { heading: 'Goal', hint: 'What is true once this milestone is reached.' },
      {
        heading: 'Exit criteria',
        hint: 'A checkbox for each thing that must hold to call it done.',
      },
      {
        heading: 'Retrospective',
        hint: 'Filled in at the end: what went well, what did not, what to change.',
      },
      { heading: 'Changelog', hint: 'Filled in at the end: what shipped, for the release notes.' },
    ],
  },
  decision: {
    kind: 'decision',
    prefix: 'D',
    folder: 'decisions',
    label: 'Decision',
    plural: 'Decisions',
    statuses: ['proposed', 'accepted', 'superseded'],
    sections: [
      { heading: 'Context', hint: 'The problem and the forces at play.' },
      { heading: 'Decision', hint: 'What was chosen.' },
      {
        heading: 'Consequences',
        hint: 'What follows from it, good and bad, and what it rules out.',
      },
    ],
  },
  workaround: {
    kind: 'workaround',
    prefix: 'W',
    folder: 'workarounds',
    label: 'Workaround',
    plural: 'Workarounds',
    statuses: ['open', 'fixed', 'wont-fix'],
    sections: [
      { heading: 'What we did', hint: 'The workaround itself.' },
      {
        heading: 'Why',
        hint: 'The bug or missing feature it works around, with a link when there is one.',
      },
      { heading: 'Proper fix', hint: 'What to do once the real fix is out.' },
      { heading: 'Where', hint: 'The files and lines to change back.' },
    ],
  },
  risk: {
    kind: 'risk',
    prefix: 'R',
    folder: 'risks',
    label: 'Risk',
    plural: 'Risks',
    statuses: ['open', 'mitigated', 'closed'],
    sections: [
      { heading: 'Risk', hint: 'What could go wrong and what it would cost.' },
      { heading: 'Mitigation', hint: 'What lowers the chance or the cost, and who does it.' },
    ],
  },
  question: {
    kind: 'question',
    prefix: 'Q',
    folder: 'questions',
    label: 'Question',
    plural: 'Questions',
    statuses: ['open', 'answered'],
    sections: [
      { heading: 'Question', hint: 'What needs deciding, and the options when there are some.' },
      { heading: 'Answer', hint: 'The answer, once there is one.' },
    ],
  },
};

const STATUS_ALIASES: Record<string, string> = {
  planned: 'planned',
  todo: 'planned',
  'in-progress': 'active',
  current: 'active',
  complete: 'done',
  completed: 'done',
  draft: 'proposed',
  approved: 'accepted',
  replaced: 'superseded',
  resolved: 'fixed',
  removed: 'fixed',
  wontfix: 'wont-fix',
  "won't-fix": 'wont-fix',
  accepted: 'accepted',
  handled: 'mitigated',
};

export interface RelayItem {
  kind: RelayItemKind;
  id: string;
  title: string;
  status: string;
  /** File name inside the kind's folder. */
  file: string;
  body: string;
  /** The task (T###) it came from or belongs to. */
  task: string | null;
  created: string | null;
  owner: string | null;
  /** Milestone: the date it should be reached by. */
  target: string | null;
  /** Workaround: the package it waits on, its ecosystem (npm, cargo, nuget, pip...) and version. */
  dependency: string | null;
  ecosystem: string | null;
  waitingFor: string | null;
  /** Workaround: a date to look at it again whatever happens. */
  revisitBy: string | null;
  /** Risk: how likely and how bad. */
  likelihood: RelayLevel | null;
  impact: RelayLevel | null;
  issues: RelayIssue[];
}

export interface RelayItemDraft {
  kind: RelayItemKind;
  id: string;
  title: string;
  status?: string;
  task?: string | null;
  created?: string | null;
  owner?: string | null;
  target?: string | null;
  dependency?: string | null;
  ecosystem?: string | null;
  waitingFor?: string | null;
  revisitBy?: string | null;
  likelihood?: RelayLevel | null;
  impact?: RelayLevel | null;
  /** Text for the kind's sections, by heading. A section with no text keeps its hint. */
  sections?: Record<string, string>;
}

function itemIdPattern(kind: RelayItemKind): RegExp {
  return new RegExp(`^${RELAY_ITEM_SPECS[kind].prefix}\\d{3,}$`);
}

export function isRelayItemId(kind: RelayItemKind, value: string): boolean {
  return itemIdPattern(kind).test(value);
}

/** The id an item file is named after, or null for anything else. */
export function itemIdFromFileName(kind: RelayItemKind, name: string): string | null {
  const prefix = RELAY_ITEM_SPECS[kind].prefix;
  return new RegExp(`^(${prefix}\\d{3,})(?:-[^/\\\\]*)?\\.md$`).exec(name)?.[1] ?? null;
}

/** The id after the highest one in use, at least three digits wide. */
export function nextItemId(kind: RelayItemKind, ids: Iterable<string>): string {
  const prefix = RELAY_ITEM_SPECS[kind].prefix;
  let highest = 0;
  for (const id of ids) {
    if (isRelayItemId(kind, id)) highest = Math.max(highest, Number(id.slice(prefix.length)));
  }
  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}

/** `D004-use-sqlite.md`, named the way task files are. */
export function itemFileName(id: string, title: string): string {
  return taskFileName(id, title);
}

const TASK_REF = /^T\d{3,}$/;

export function parseItemFile(kind: RelayItemKind, file: string, content: string): RelayItem {
  const spec = RELAY_ITEM_SPECS[kind];
  const { data, body, issue } = splitFrontMatter(content);
  const issues: RelayIssue[] = issue ? [issue] : [];
  const fileId = itemIdFromFileName(kind, file);
  const declared = frontMatterText(data.id)?.toUpperCase() ?? null;
  let id = fileId ?? '';
  if (declared && isRelayItemId(kind, declared)) {
    if (fileId && declared !== fileId) {
      issues.push({
        field: 'id',
        message: `The front matter says ${declared} but the file is named for ${fileId}.`,
      });
    }
    id = declared;
  } else if (declared) {
    issues.push({ field: 'id', message: `"${declared}" is not a ${spec.label.toLowerCase()} id.` });
  }

  const status =
    readChoice('status', data.status, spec.statuses, STATUS_ALIASES, issues) ?? spec.statuses[0];
  const task = frontMatterText(data.task)?.toUpperCase() ?? null;
  if (task && !TASK_REF.test(task)) {
    issues.push({ field: 'task', message: `"${task}" is not a task id like T001.` });
  }
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const level = (field: string, value: unknown): RelayLevel | null =>
    readChoice(field, value, RELAY_LEVELS, { med: 'medium', moderate: 'medium' }, issues);
  const day = (value: unknown): string | null => {
    const raw = frontMatterText(value);
    return raw && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw;
  };
  return {
    kind,
    id,
    title: frontMatterText(data.title) ?? heading ?? id,
    status,
    file,
    body,
    task: task && TASK_REF.test(task) ? task : null,
    created: day(data.created),
    owner: frontMatterText(data.owner),
    target: day(data.target),
    dependency: frontMatterText(data.dependency),
    ecosystem: frontMatterText(data.ecosystem)?.toLowerCase() ?? null,
    waitingFor: frontMatterText(data.waitingFor),
    revisitBy: day(data.revisitBy),
    likelihood: level('likelihood', data.likelihood),
    impact: level('impact', data.impact),
    issues,
  };
}

/** Writes a new item file with the kind's sections, front matter first. */
export function renderItemFile(draft: RelayItemDraft): string {
  const spec = RELAY_ITEM_SPECS[draft.kind];
  const front = [
    `id: ${draft.id}`,
    `title: ${yamlScalar(draft.title)}`,
    `status: ${draft.status ?? spec.statuses[0]}`,
  ];
  const optional: [string, string | null | undefined][] = [
    ['task', draft.task],
    ['created', draft.created],
    ['owner', draft.owner],
    ['target', draft.target],
    ['dependency', draft.dependency],
    ['ecosystem', draft.ecosystem],
    ['waitingFor', draft.waitingFor],
    ['revisitBy', draft.revisitBy],
    ['likelihood', draft.likelihood],
    ['impact', draft.impact],
  ];
  for (const [key, value] of optional) {
    if (value?.trim()) front.push(`${key}: ${yamlScalar(value.trim())}`);
  }
  const given = Object.fromEntries(
    Object.entries(draft.sections ?? {}).map(([heading, text]) => [heading.toLowerCase(), text]),
  );
  const sections = spec.sections.map((section) => {
    const text = given[section.heading.toLowerCase()]?.trim();
    return `## ${section.heading}\n\n${text || `<!-- ${section.hint} -->`}`;
  });
  return `---\n${front.join('\n')}\n---\n\n${sections.join('\n\n')}\n`;
}

/** The text under one `## heading` of an item or task body, without hint comments. */
export function bodySection(body: string, heading: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const wanted = heading.toLowerCase();
  const start = lines.findIndex(
    (line) => /^#{1,4}\s+(.+?)\s*#*\s*$/.exec(line)?.[1].toLowerCase() === wanted,
  );
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length && !/^#{1,4}\s+/.test(lines[end])) end += 1;
  return lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Journal: one entry per session, written by Runova
// ---------------------------------------------------------------------------------------------

export interface RelayJournalEntry {
  /** ISO time the session ended. */
  at: string;
  legNo: number;
  cliId: string;
  model: string | null;
  effort: string | null;
  /** What the session left: its outcome, or how it ended without one. */
  result: RelayOutcome | 'failed' | 'interrupted' | 'skipped' | 'unknown';
  tests: RelayTestResult | null;
  /** The most context the session held, when it could be measured. */
  peakContextTokens: number | null;
  minutes: number | null;
  /** The commit the session made, when there was one. */
  commit: string | null;
  /** The attempt the session belonged to, when the task was ever redone. */
  attempt: number | null;
}

function journalHeader(taskId: string): string {
  return `---\ntask: ${taskId}\n---\n\n# Journal of ${taskId}\n\nRunova adds an entry each time a session on this task ends. Newest last.\n`;
}

export function renderJournalEntry(entry: RelayJournalEntry): string {
  const lines = [
    `## ${entry.at.slice(0, 16).replace('T', ' ')} session ${entry.legNo}`,
    '',
    `- Agent: ${[entry.cliId, entry.model, entry.effort].filter(Boolean).join(', ')}`,
    `- Result: ${entry.result}`,
    `- Tests: ${entry.tests ?? 'not reported'}`,
  ];
  if (entry.attempt != null && entry.attempt > 1) lines.push(`- Attempt: ${entry.attempt}`);
  if (entry.peakContextTokens != null) {
    lines.push(`- Context: ${Math.round(entry.peakContextTokens / 1000)}K tokens at most`);
  }
  if (entry.minutes != null) lines.push(`- Time: ${entry.minutes} min`);
  if (entry.commit) lines.push(`- Commit: ${entry.commit}`);
  return lines.join('\n');
}

/** The journal with one more entry at the end. An absent journal starts with its header. */
export function appendJournalEntry(
  existing: string | null,
  taskId: string,
  entry: RelayJournalEntry,
): string {
  const base = (existing ?? journalHeader(taskId)).replace(/\s+$/, '');
  return `${base}\n\n${renderJournalEntry(entry)}\n`;
}

export interface RelayJournalView {
  heading: string;
  lines: string[];
}

/** The entries of a journal, oldest first, as their headings and bullet lines. */
export function parseJournal(content: string): RelayJournalView[] {
  const { body } = splitFrontMatter(content);
  const entries: RelayJournalView[] = [];
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1];
    if (heading) {
      entries.push({ heading, lines: [] });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1];
    if (bullet && entries.length > 0) entries[entries.length - 1].lines.push(bullet);
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Paths, relative to the project, posix style
// ---------------------------------------------------------------------------------------------

function joinPosix(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export function planRelPath(docsFolder: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, RELAY_PLAN_FILE);
}

export function itemFolderRelPath(docsFolder: string, kind: RelayItemKind): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, RELAY_ITEM_SPECS[kind].folder);
}

export function journalRelPath(docsFolder: string, taskId: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, RELAY_JOURNAL_DIR, `${taskId}.md`);
}

export function archiveRelPath(docsFolder: string, taskId: string, attempt: number): string {
  return joinPosix(
    docsFolder,
    RELAY_TASKS_DIR,
    'handoffs',
    RELAY_ARCHIVE_DIR,
    `${taskId}-attempt-${attempt}.md`,
  );
}

/** A redone attempt's archive: its handoff, then its journal, so one file tells the whole try. */
export function renderAttemptArchive(input: {
  taskId: string;
  attempt: number;
  handoff: string | null;
  journal: string | null;
  agent: string | null;
}): string {
  const header = stringifyYaml({
    task: input.taskId,
    attempt: input.attempt,
    ...(input.agent ? { agent: input.agent } : {}),
  }).trimEnd();
  const handoffBody = input.handoff ? splitFrontMatter(input.handoff).body.trim() : '';
  const journalBody = input.journal
    ? splitFrontMatter(input.journal)
        .body.replace(/^#\s+.*$/m, '')
        .trim()
    : '';
  return [
    `---\n${header}\n---`,
    `# ${input.taskId}, attempt ${input.attempt}`,
    '## Handoff',
    handoffBody || 'No handoff was written.',
    '## Journal',
    journalBody || 'No session was recorded.',
  ]
    .join('\n\n')
    .concat('\n');
}

/**
 * The run options a plan turns on for everyone who runs it. A plan only turns options on, never
 * off, so a choice made on this computer is never silently undone. Plan mode always rolls on and
 * runs past the budget, since it has none.
 */
export function planRunOptions(plan: RelayPlan): {
  keepRolling?: true;
  runPastBudget?: true;
  reviewEachTask?: true;
  defaultBudget?: number;
} {
  const options: ReturnType<typeof planRunOptions> = {};
  if (plan.mode === 'plan' || plan.keepRolling) options.keepRolling = true;
  if (plan.mode === 'plan' || plan.runPastBudget) options.runPastBudget = true;
  if (plan.reviewEachTask) options.reviewEachTask = true;
  if (plan.mode === 'fit' && plan.budget) options.defaultBudget = plan.budget;
  return options;
}

/** How a session's leg record reads in its task's journal. */
export function journalResult(
  result: 'done' | 'continue' | 'blocked' | 'testing' | 'failed' | 'interrupted' | 'marked-done',
): RelayJournalEntry['result'] {
  if (result === 'testing' || result === 'marked-done') return 'done';
  return result;
}
