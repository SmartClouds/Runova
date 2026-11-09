/**
 * The one line a phone shows. Normally the server writes it. When the person has asked for their
 * notifications to be encrypted the server must not see the names, so this computer writes it from
 * the same templates. `push-lines-v1.json` holds the two to the same words.
 */

const MAX_LINE = 140;

const TEMPLATES: Record<string, Record<string, string>> = {
  'agent-needs-input': { '': '{agent} needs your input in {project}' },
  'agent-finished': { '': '{agent} finished in {project}' },
  tasks: {
    finished: '{subject} finished in {project}',
    failed: '{subject} failed in {project}',
    'needs-input': '{subject} needs your input in {project}',
    added: 'A task was added in {project}',
  },
  pipelines: {
    failed: '{subject} failed in {project}',
    passed: '{subject} passed in {project}',
    fixed: 'Auto-fix got {subject} passing in {project}',
    attention: 'Auto-fix needs you in {project}',
    'gave-up': 'Auto-fix gave up on {subject} in {project}',
  },
  deploys: {
    critical: 'Critical alert on {subject}',
    warning: 'Warning on {subject}',
    info: 'Notice on {subject}',
    review: '{subject} needs a look',
  },
  monitors: { failed: '{subject} is down', recovered: '{subject} is back up' },
  relay: {
    attention: 'A Relay task needs you in {project}',
    finished: 'A relay finished in {project}',
    'planner-ready': 'A plan is ready to review in {project}',
    'planner-failed': 'Planning failed in {project}',
  },
  'ai-limits': { threshold: '{subject} is close to its limit', reset: '{subject} has reset' },
  'security-news': { '': 'A security alert affects {subject}' },
  'tool-updates': { '': 'An update is available for {subject}' },
  remote: {
    connected: '{subject} connected to this computer',
    locked: 'Password access to this computer was locked',
  },
};

export interface PushLineInput {
  category: string;
  status?: string | null | undefined;
  agent?: string | null | undefined;
  project?: string | null | undefined;
  subject?: string | null | undefined;
}

function clip(line: string): string {
  return line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE - 3)}...`;
}

/** The line for this event, or null when the server would have refused it too. */
export function composePushLine(input: PushLineInput): string | null {
  const template = TEMPLATES[input.category]?.[input.status ?? ''];
  if (template === undefined) return null;
  const values = { agent: input.agent, project: input.project, subject: input.subject };
  for (const [name, value] of Object.entries(values)) {
    if (template.includes(`{${name}}`) && !value) return null;
  }
  // A function, so a name holding "$&" can't be read as a replacement pattern.
  const line = template.replace(
    /\{(agent|project|subject)\}/g,
    (_, name: keyof typeof values) => values[name] ?? '',
  );
  return clip(line);
}
