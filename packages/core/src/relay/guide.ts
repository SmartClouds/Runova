import { HANDOFF_SECTIONS, RELAY_HANDOFFS_DIR, tasksFolderRelPath } from './format.js';
import { RELAY_ARCHIVE_DIR, RELAY_ITEM_SPECS, RELAY_JOURNAL_DIR, RELAY_PLAN_FILE } from './plan.js';

/**
 * The guide's version, as a comment on its first line. Runova rewrites a guide it wrote itself when
 * the version is older, and never touches one without its marker that a person wrote.
 */
export const RELAY_GUIDE_VERSION = 2;
const MARKER = `<!-- runova-relay-guide: ${RELAY_GUIDE_VERSION} -->`;

/**
 * Whether a guide on disk should be replaced by the current one: it is Runova's own (it says so)
 * and older than this version.
 */
export function relayGuideIsStale(existing: string): boolean {
  if (existing.includes(MARKER)) return false;
  const version = /<!-- runova-relay-guide: (\d+) -->/.exec(existing)?.[1];
  if (version) return Number(version) < RELAY_GUIDE_VERSION;
  // Version 1 had no marker; it is recognised by the line it ended its introduction with.
  return /Runova wrote it; keep it as it is\./.test(existing);
}

function folderOf(kind: keyof typeof RELAY_ITEM_SPECS, tasks: string): string {
  return `${tasks}${RELAY_ITEM_SPECS[kind].folder}/`;
}

/**
 * The guide that lives next to the tasks. Prompts point at it instead of repeating the rules, so
 * each session spends its context on the work.
 */
export function relayGuideMarkdown(docsFolder: string): string {
  const tasks = `${tasksFolderRelPath(docsFolder)}/`;
  const handoffs = `${tasks}${RELAY_HANDOFFS_DIR}/`;
  const sections = HANDOFF_SECTIONS.map(
    (section) => `- \`## ${section.heading}\`: ${section.hint}`,
  ).join('\n');
  return `${MARKER}
# Relay

This project's work is split into tasks. Runova runs them one after another, each in a fresh AI
coding session, and every session leaves a handoff that the next one reads first. Everything about
the plan lives in this folder as Markdown, so git keeps its history. This file is the format.
Runova wrote it and may update it; keep it as it is.

## Files

- \`${tasks}${RELAY_PLAN_FILE}\`: the plan. Its goal, its mode, the definition of done and what is
  out of scope. Read it before you start.
- \`${tasks}T001-short-slug.md\`: one task per file, named after its id. The task is also its spec.
- \`${handoffs}T001.md\`: the handoff for that task, written by the session working on it.
- \`${tasks}${RELAY_JOURNAL_DIR}/T001.md\`: a journal of every session on that task. Runova writes it;
  never edit it.
- \`${handoffs}${RELAY_ARCHIVE_DIR}/T001-attempt-1.md\`: an earlier attempt at a task that was
  started over, with its handoff and journal.
- \`${folderOf('milestone', tasks)}M001-slug.md\`: milestones that group tasks.
- \`${folderOf('decision', tasks)}D001-slug.md\`: decisions that later tasks rely on.
- \`${folderOf('workaround', tasks)}W001-slug.md\`: workarounds to remove when a fix comes out.
- \`${folderOf('risk', tasks)}R001-slug.md\`: risks to the plan.
- \`${folderOf('question', tasks)}Q001-slug.md\`: questions for the user.

## Task files

Each task file starts with YAML front matter:

\`\`\`yaml
id: T001            # T and at least three digits, never reused
title: Short imperative title
status: todo        # todo | in-progress | testing | done | blocked
epic: E01           # optional group label
order: 1            # optional, breaks ties between tasks that are ready together
depends: [T000]     # ids that must be done first
estimate: 90000     # context tokens one session should need (fit mode)
budget: 200000      # context tokens one session may use (fit mode)
specs: [docs/epics/01-example.md]
priority: p1        # optional: p0 (most urgent) to p3
size: m             # optional: xs, s, m, l, xl (plan mode)
milestone: M001     # optional
labels: [api]       # optional
agent: claude-code  # optional: the CLI the task should run with
due: 2026-12-31     # optional
\`\`\`

Runova also writes \`attempt\`, \`started\` and \`finished\`.

The body has \`## Goal\`, \`## Scope\`, \`## Acceptance criteria\` (a checkbox per criterion) and
\`## Test plan\`. A task planned in plan mode also has \`## Context\`, \`## Approach\`,
\`## Interfaces and files\`, \`## Out of scope\` and \`## Risks\`.

Runova sets \`status\`. A session working on a task never edits its status or its spec; it
reports through the handoff.

### Sizing

${RELAY_PLAN_FILE} says the plan's \`mode\`.

- \`mode: fit\` (the default): a task should fit in one session under its budget, counting
  everything the session reads: the task, the handoffs it depends on, the specs, the code it opens,
  and the output of the commands it runs. Aim for an \`estimate\` of at most 60% of the budget.
  When ${RELAY_PLAN_FILE} sets \`keepRolling: true\`, a task may be bigger: it carries on in fresh
  sessions from its handoff.
- \`mode: plan\`: a task is one part of the job that can be built, reviewed and tested on its own,
  whatever context it takes. There is no estimate or budget to keep to.

Either way, every task ends with something that can be tested.

## Handoffs

Before a session stops, it writes \`${handoffs}<id>.md\` with this front matter:

\`\`\`yaml
task: T001
outcome: done       # done | continue | blocked
tests: passed       # passed | failed | not-run
leg: 1              # the session number the prompt gave you
updated: 2026-01-31T12:00:00Z
\`\`\`

and these sections, all of them filled in:

${sections}

Outcomes:

- \`outcome: done\`: every acceptance criterion is met and the tests pass.
- \`outcome: continue\`: the work is not finished. Use it when your context nears the budget, or
  when the prompt tells you the budget is reached. Finish the current small step, write the
  handoff so a new session can carry on without rereading everything, then stop.
- \`outcome: blocked\`: you need the user. Write the question as a Q### file, name it under
  \`## Next step\`, and stop.

Rewrite the handoff as a whole each time, so it always describes the task as it stands now. Keep
it short: the next session reads it first, and every line costs its context.

## Records you keep

These outlive the task, so later tasks, and anyone redoing the work with another agent, start
from what you learned. Number each new file from the highest id in its folder, and name the task
it came from under \`task\`.

- **A decision** that later tasks rely on (a library, a data shape, a convention): write
  \`${folderOf('decision', tasks)}D###-slug.md\` with \`id\`, \`title\`, \`status: accepted\` and \`task\`,
  and the sections Context, Decision and Consequences.
- **A workaround** for a bug or a missing feature in something you depend on: write
  \`${folderOf('workaround', tasks)}W###-slug.md\` with \`id\`, \`title\`, \`status: open\` and \`task\`,
  plus \`dependency\` (the package), \`ecosystem\` (npm, cargo, nuget, pip, maven...) and
  \`waitingFor\` (the version or the issue that fixes it), or \`revisitBy\` (a date) when there is no
  version to wait for. Its sections are What we did, Why, Proper fix and Where (the files to change
  back). Mark the code with a comment that names the W### id.
- **A question** only the user can answer: write \`${folderOf('question', tasks)}Q###-slug.md\` with
  \`id\`, \`title\`, \`status: open\` and \`task\`, and the sections Question and Answer (empty).
- **A risk** to the plan that you notice: write \`${folderOf('risk', tasks)}R###-slug.md\` with
  \`likelihood\` and \`impact\` (low, medium or high) and the sections Risk and Mitigation.

Name each new record in the matching section of your handoff. When you remove a workaround because
its fix came out, set its \`status: fixed\`.
`;
}
