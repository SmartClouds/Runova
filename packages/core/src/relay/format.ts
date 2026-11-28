import type { HandoffSectionKey } from './types.js';

/** Folder, under the docs folder, that holds the task files. */
export const RELAY_TASKS_DIR = 'tasks';
/** Folder, under the tasks folder, that holds one handoff per task. */
export const RELAY_HANDOFFS_DIR = 'handoffs';
/** The guide Runova writes into the tasks folder so any agent can follow the format. */
export const RELAY_GUIDE_FILE = 'RELAY.md';

export const DEFAULT_RELAY_BUDGET = 200_000;
/** The budgets the pickers offer. A task file may still name any other number. */
export const RELAY_BUDGET_CHOICES = [100_000, 200_000, 400_000, 1_000_000] as const;

const TASK_ID = /^T\d{3,}$/;
const TASK_FILE = /^(T\d{3,})(?:-[^/\\]*)?\.md$/;
const SLUG_MAX = 48;

export function isRelayTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, SLUG_MAX).replace(/-+$/, '');
}

/** `T001-parse-the-format.md`, or just `T001.md` when the title has nothing ascii to slug. */
export function taskFileName(id: string, title: string): string {
  const slug = slugify(title);
  return slug ? `${id}-${slug}.md` : `${id}.md`;
}

/** The id a task file is named after, or null for anything that is not a task file. */
export function taskIdFromFileName(name: string): string | null {
  return TASK_FILE.exec(name)?.[1] ?? null;
}

/** The id after the highest one in use, at least three digits wide. */
export function nextTaskId(ids: Iterable<string>): string {
  let highest = 0;
  for (const id of ids) {
    if (isRelayTaskId(id)) highest = Math.max(highest, Number(id.slice(1)));
  }
  return `T${String(highest + 1).padStart(3, '0')}`;
}

function joinPosix(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export function tasksFolderRelPath(docsFolder: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR);
}

export function taskRelPath(docsFolder: string, file: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, file);
}

export function handoffRelPath(docsFolder: string, taskId: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, RELAY_HANDOFFS_DIR, `${taskId}.md`);
}

export function guideRelPath(docsFolder: string): string {
  return joinPosix(docsFolder, RELAY_TASKS_DIR, RELAY_GUIDE_FILE);
}

/** Reads `120000`, `120k`, `1.5M` or `120,000`. Anything else is null. */
export function parseTokenCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value.replace(/[,_\s]/g, ''));
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const scale = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
  return Math.round(Number(match[1]) * scale);
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** `200K`, `1.5M`, `950`. */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${oneDecimal(count / 1_000_000)}M`;
  if (count >= 1_000) return `${oneDecimal(count / 1_000)}K`;
  return String(Math.round(count));
}

export interface HandoffSectionSpec {
  key: HandoffSectionKey;
  heading: string;
  /** What the section is for, as the guide and the prompts describe it. */
  hint: string;
  /**
   * Added after the first five (E121). Required only when the handoff has its heading, so a
   * handoff written before it existed still counts as complete.
   */
  sinceTemplate?: boolean;
}

/** The parts of a handoff, in the order the template writes them. */
export const HANDOFF_SECTIONS: readonly HandoffSectionSpec[] = [
  { key: 'purpose', heading: 'Purpose', hint: 'What the task is for, in one or two sentences.' },
  {
    key: 'done',
    heading: 'Done so far',
    hint: 'What is finished and working, with the files and tests that prove it.',
  },
  {
    key: 'decisions',
    heading: 'Decisions',
    hint: 'Choices made and why, so the next session does not reopen them.',
  },
  {
    key: 'tests',
    heading: 'Tests run',
    hint: 'The test commands you ran, what they reported, and what is not covered yet. Write "None." if you ran none.',
    sinceTemplate: true,
  },
  {
    key: 'workarounds',
    heading: 'Workarounds',
    hint: 'Each workaround you put in, by its W### file, with what it waits for. Write "None." if there are none.',
    sinceTemplate: true,
  },
  {
    key: 'rejected',
    heading: 'Tried and rejected',
    hint: 'Approaches that were tried or ruled out, and why. Write "None." if there were none.',
  },
  {
    key: 'questions',
    heading: 'Open questions',
    hint: 'What the next session or the user still has to settle, by its Q### file. Write "None." if nothing is open.',
    sinceTemplate: true,
  },
  {
    key: 'next',
    heading: 'Next step',
    hint: 'The exact next action. For a blocked task, the question the user must answer.',
  },
];

/** A fresh handoff, as the first session of a task finds it. */
export function renderHandoffTemplate(task: { id: string; title: string }): string {
  const sections = HANDOFF_SECTIONS.map(
    (section) => `## ${section.heading}\n\n<!-- ${section.hint} -->\n`,
  ).join('\n');
  return `---
task: ${task.id}
outcome: continue
tests: not-run
leg: 0
updated:
---

${sections}`;
}

/**
 * A handoff written for a session to find, when catching up a project whose work started before
 * Relay: finished work gets one with `outcome: done`, half-done work one that says where it stands.
 * A section left out keeps its hint, as in the template.
 */
export function renderHandoff(input: {
  id: string;
  outcome: 'done' | 'continue';
  sections: Partial<Record<HandoffSectionKey, string>>;
}): string {
  const sections = HANDOFF_SECTIONS.map((section) => {
    const text = input.sections[section.key]?.trim();
    return `## ${section.heading}\n\n${text || `<!-- ${section.hint} -->`}\n`;
  }).join('\n');
  return `---
task: ${input.id}
outcome: ${input.outcome}
tests: not-run
leg: 0
updated:
---

${sections}`;
}
