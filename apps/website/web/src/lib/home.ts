/** Copy for the home page, written from the README. Each highlight shows one T012/T013 screenshot. */

export interface AdePoint {
  title: string;
  body: string;
  /** An icon name from src/components/effects/Icon.astro. */
  icon: 'layout-grid' | 'git-commit' | 'gauge' | 'list-checks' | 'shield-check';
}

export const ADE_POINTS: AdePoint[] = [
  {
    icon: 'layout-grid',
    title: 'Several agents in view at once',
    body: 'A workspace is a tree of panes, not a single editor. Each pane holds a CLI or a shell with its own folder, and Runova shows whether every agent is working, waiting on you or done.',
  },
  {
    icon: 'git-commit',
    title: 'The loop closes in one place',
    body: 'Read the diff, stage hunks, run the tests, send the failure back to the agent, commit, tag and watch the pipeline, all in the window where the code was written.',
  },
  {
    icon: 'gauge',
    title: 'Tokens and quotas up front',
    body: 'Agents cost money and burn through limits, so tokens, cost and rate limits are always on screen, and an agent tab can wait out a limit and continue by itself.',
  },
  {
    icon: 'list-checks',
    title: 'Long jobs outgrow one session',
    body: 'Relay cuts the work into tasks that each fit an agent’s context, runs them one after another in fresh sessions, and passes what each session learned to the next.',
  },
  {
    icon: 'shield-check',
    title: 'Agents run what they read',
    body: 'Skills are scanned before an agent reads them, secrets live in an encrypted vault instead of a .env in the repo, and risky SSH commands stop for your approval.',
  },
];

/** Agent CLIs named in the README that Dev Tools detects and installs. */
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
    body: 'Dev Tools finds the coding CLIs on your machine and installs or updates the missing ones in one click. Save each one’s flags, model and effort, and check a skill for risky instructions before an agent reads it.',
  },
  {
    slug: 'ship',
    shot: 'deploy-overview',
    eyebrow: 'Ship',
    title: 'From commit to your own servers',
    body: 'Run GitHub Actions, then deploy to your Linux servers over SSH: apps, containers, websites, certificates and the firewall. Monitoring watches each environment and hands a failure to an agent with Fix with AI.',
  },
];

export interface PhonePoint {
  title: string;
  body: string;
  /** An icon name from src/components/effects/Icon.astro. */
  icon: 'bot' | 'git-commit' | 'rocket' | 'send' | 'bell' | 'key-round';
}

/** What the phone apps do, from the help article "Runova on your phone" (phone.md). */
export const PHONE_POINTS: PhonePoint[] = [
  {
    icon: 'bot',
    title: 'Answer your agents',
    body: 'Read the CLIs running on your computer live, answer a question, send a prompt or start an agent with its model and effort.',
  },
  {
    icon: 'git-commit',
    title: 'Commit and review',
    body: 'Diffs, staging, commits, branches, tags and pull requests, with the AI help from your computer.',
  },
  {
    icon: 'rocket',
    title: 'Keep the servers running',
    body: 'Deploy, monitors, pipelines, Cloudflare, and the traffic and attacks of every website, with Block one tap away.',
  },
  {
    icon: 'send',
    title: 'Send files both ways',
    body: 'Files, photos and folders go from the phone to your computers and your teammates’, and back from your own computers.',
  },
  {
    icon: 'bell',
    title: 'Hear about it first',
    body: 'Every Runova notification reaches the phone, each category with its own switch.',
  },
  {
    icon: 'key-round',
    title: 'The Vault, behind your face',
    body: 'Open the computer’s Vault with its passphrase. Each secret you reveal asks for your fingerprint or face first.',
  },
];

/** The phone screens beside the list, in order from back left to front right. */
export const PHONE_SHOTS = ['systems', 'terminal', 'traffic', 'send-files'] as const;

export interface SecurityPoint {
  title: string;
  body: string;
  /** Short technical facts, shown as chips. */
  facts: string[];
  /** An icon name from src/components/effects/Icon.astro. */
  icon: 'lock' | 'eye-off' | 'key-round' | 'shield-check' | 'fingerprint' | 'send';
}

/**
 * The security section. Every line comes from the epics that built it: E61 and E62 (Anywhere and
 * the relay), E112 (sending files), E48 (sync), E92 (encrypted notifications and sync), E77 and E106
 * (the Vault and the lock on the phone). No claim goes past what those say.
 */
export const SECURITY_POINTS: SecurityPoint[] = [
  {
    icon: 'lock',
    title: 'End to end between your devices',
    body: 'Every computer and phone has its own identity key. Each session agrees fresh keys signed with it, and every frame after that is sealed. Both screens show the same six-digit safety code, so you can check nobody sits in between.',
    facts: ['X25519', 'Ed25519', 'AES-256-GCM'],
  },
  {
    icon: 'eye-off',
    title: 'The relay only carries sealed frames',
    body: 'When two devices can not reach each other directly, Runova’s relay passes the sealed frames along without reading them. It notes only that a session paired and how long it lasted. Sent files take the same link and leave no record.',
    facts: ['No session content', 'No file records'],
  },
  {
    icon: 'key-round',
    title: 'Secrets only your computers can open',
    body: 'Passwords, keys and tokens leave your computer sealed with a key that only your computers hold. The server keeps only wrapped copies it can not open, and nobody can recover a lost passphrase, Runova included.',
    facts: ['scrypt', 'AES-256-GCM', '24-word recovery key'],
  },
  {
    icon: 'shield-check',
    title: 'Seal notifications and all of sync',
    body: 'On Go, Pro and Ultra, one switch seals what your computers tell your phone, and another seals every record in your sync. The server still sees that something happened and when, but not what it says.',
    facts: ['Per-phone keys', 'Your choice per item'],
  },
  {
    icon: 'fingerprint',
    title: 'A phone that locks itself',
    body: 'Lock the app with a code or a password, or open it with Face ID, Touch ID or a fingerprint. Vault screens block screenshots and hide in the app switcher, and a computer decides what each phone may do.',
    facts: ['App lock', 'Biometrics', 'Per-computer access'],
  },
];
