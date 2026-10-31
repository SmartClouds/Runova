/** Copy for the home page, written from the README. Each highlight shows one T012/T013 screenshot. */

export interface AdePoint {
  title: string;
  body: string;
}

export const ADE_POINTS: AdePoint[] = [
  {
    title: 'Several agents in view at once',
    body: 'A workspace is a tree of panes, not a single editor. Each pane holds a CLI or a shell with its own folder, and Runova shows whether every agent is working, waiting on you or done.',
  },
  {
    title: 'The loop closes in one place',
    body: 'Read the diff, stage hunks, run the tests, send the failure back to the agent, commit, tag and watch the pipeline, all in the window where the code was written.',
  },
  {
    title: 'Tokens and quotas up front',
    body: 'Agents cost money and burn through limits, so tokens, cost and rate limits are always on screen, and an agent tab can wait out a limit and continue by itself.',
  },
  {
    title: 'Long jobs outgrow one session',
    body: 'Relay cuts the work into tasks that each fit an agent’s context, runs them one after another in fresh sessions, and passes what each session learned to the next.',
  },
  {
    title: 'Agents run what they read',
    body: 'Skills are scanned before an agent reads them, secrets live in an encrypted vault instead of a .env in the repo, and risky SSH commands stop for your approval.',
  },
];

/** Agent CLIs named in the README that the AI CLI Manager detects and installs. */
export const AGENT_CLIS = [
  'Claude Code',
  'Codex',
  'Cursor',
  'Gemini',
  'Grok',
  'OpenCode',
  'GitHub Copilot CLI',
  'Aider',
  'Goose',
  'Cline',
];

export interface Highlight {
  /** The features entry this highlight links to, `/features/<slug>` (T015). */
  slug: string;
  /** The screenshot name in src/assets/screenshots/manifest.json. */
  shot: string;
  eyebrow: string;
  title: string;
  body: string;
}

export const HIGHLIGHTS: Highlight[] = [
  {
    slug: 'workspace',
    shot: 'workspace',
    eyebrow: 'Workspace',
    title: 'Every agent in its own pane',
    body: 'Split the window into as many panes as you like and put Claude Code, Codex, Gemini or a shell in each. Pick the model and reasoning effort before an agent starts, and give each task its own git worktree so agents never touch each other’s files.',
  },
  {
    slug: 'git-and-review',
    shot: 'workspace-git',
    eyebrow: 'Git and review',
    title: 'Review the change next to the agent that made it',
    body: 'Source control, the diff viewer and the editor sit beside the panes. Stage a single hunk, commit, branch and tag without switching apps, and hand a merge conflict to an agent when you would rather not.',
  },
  {
    slug: 'relay',
    shot: 'relay',
    eyebrow: 'Relay',
    title: 'Big jobs, one session at a time',
    body: 'Split a job into task files that each fit one session’s context. Runova runs them in fresh sessions one after another, every session leaves a handoff for the next, and the cards move across the board by themselves.',
  },
  {
    slug: 'token-usage',
    shot: 'usage',
    eyebrow: 'Token usage',
    title: 'Know what the agents cost',
    body: 'Tokens, cost and rate limit quotas across 60+ providers, read from local logs for Claude Code and Codex with no API key. Turn on auto-continue and a tab picks up again once a limit resets.',
  },
  {
    slug: 'agents',
    shot: 'cli-manager',
    eyebrow: 'Agents',
    title: 'Every AI CLI, installed and up to date',
    body: 'The AI CLI Manager finds the coding CLIs on your machine and installs or updates the missing ones in one click. Save each one’s flags, model and effort, and check a skill for risky instructions before an agent reads it.',
  },
  {
    slug: 'ship',
    shot: 'deploy-overview',
    eyebrow: 'Ship',
    title: 'From commit to your own servers',
    body: 'Run GitHub Actions, then deploy to your Linux servers over SSH: apps, containers, websites, certificates and the firewall. Monitoring watches each environment and hands a failure to an agent with Fix with AI.',
  },
];
