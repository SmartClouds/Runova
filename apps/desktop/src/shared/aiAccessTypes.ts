/**
 * Shapes that cross IPC for AI access (E46): the tools Runova offers an agent over MCP, the
 * approvals waiting on the user, and the record of what agents did.
 */

/** How much a tool can hurt: reading, changing something, or something the user should see first. */
export const AI_TOOL_RISKS = ['read', 'write', 'sensitive'] as const;
export type AiToolRisk = (typeof AI_TOOL_RISKS)[number];

/** The parts of Runova a tool belongs to, in the order Settings lists them. */
export const AI_ACCESS_AREAS = [
  'runova',
  'projects',
  'environments',
  'apiClient',
  'git',
  'worktrees',
  'docker',
  'scheduledTasks',
  'health',
  'database',
  'pipelines',
  'skills',
  'usage',
  'security',
  'packages',
  'tests',
  'prompts',
  'deploy',
  'cloudflare',
  'ssh',
  'remote',
  'vault',
  'studio',
  'errorTracking',
  'wordpress',
  'relay',
] as const;
export type AiAccessArea = (typeof AI_ACCESS_AREAS)[number];

export const AI_ACCESS_AREA_LABELS: Record<AiAccessArea, string> = {
  runova: 'Runova',
  projects: 'Projects',
  environments: 'Environments',
  apiClient: 'API Client',
  git: 'Git',
  worktrees: 'Worktrees',
  docker: 'Docker',
  scheduledTasks: 'Scheduled tasks',
  health: 'Health and monitoring',
  database: 'Databases',
  pipelines: 'Pipelines',
  skills: 'Skills',
  usage: 'Token usage',
  security: 'Security scans',
  packages: 'Packages',
  tests: 'Tests',
  prompts: 'Prompts and blueprints',
  deploy: 'Deploy',
  cloudflare: 'Cloudflare',
  ssh: 'SSH and SFTP',
  remote: 'Remote control',
  vault: 'Vault',
  studio: 'Studio',
  errorTracking: 'Error tracking',
  wordpress: 'WordPress',
  relay: 'Relay',
};

/** A tool as Settings lists it. */
export interface AiAccessToolInfo {
  name: string;
  area: AiAccessArea;
  title: string;
  description: string;
  risk: AiToolRisk;
}

/** Whether a caller runs in one of Runova's own terminal tabs or in another app. */
export type AiCallerKind = 'runova' | 'external';

/** One labelled value in an approval. A secret value is masked until the user shows it. */
export interface AiPreviewField {
  label: string;
  value: string;
  secret?: boolean;
  /** Shown in the code font, for paths, ids and commands. */
  mono?: boolean;
}

/** What the user sees before allowing a call. Every part but the title is optional. */
export interface AiApprovalPreview {
  /** What the agent wants, as a sentence: "Update .env.local in Staging". */
  title: string;
  summary?: string;
  fields?: AiPreviewField[];
  /** A text file before and after, for edits. Masked line by line while values are hidden. */
  diff?: { fileName: string; before: string; after: string; secret?: boolean };
  /** An HTTP request about to be sent or saved. */
  request?: {
    method: string;
    url: string;
    headers?: { key: string; value: string }[];
    body?: string;
  };
}

/** An approval waiting in the Runova window. */
export interface AiAccessApproval {
  id: string;
  tool: string;
  toolTitle: string;
  area: AiAccessArea;
  risk: AiToolRisk;
  /** The agent's name as the user knows it: "Claude Code", "Codex". */
  agent: string;
  callerKind: AiCallerKind;
  projectId: string | null;
  projectName: string | null;
  preview: AiApprovalPreview;
  createdAt: number;
  expiresAt: number;
  /** Set when the user asked for approvals in the CLI but this CLI cannot show them. */
  cliFallback: boolean;
}

export type AiApprovalDecision = 'allow' | 'allow_session' | 'deny';

/** How a call ended, for the activity list. */
export type AiActivityOutcome = 'auto' | 'approved' | 'denied' | 'timeout' | 'failed' | 'refused';

export interface AiAccessActivityEntry {
  id: string;
  at: number;
  tool: string;
  toolTitle: string;
  area: AiAccessArea | null;
  risk: AiToolRisk | null;
  agent: string;
  callerKind: AiCallerKind;
  projectId: string | null;
  projectName: string | null;
  outcome: AiActivityOutcome;
  /** Why it failed or was refused. */
  detail?: string;
}

/** Sent after an agent changed something, so the screens showing it refetch. */
export interface AiAccessDataChange {
  area: AiAccessArea;
  projectId: string | null;
}

/** An app outside Runova that Settings can connect in one click. */
export type AiExternalClientId = 'claude' | 'codex';

export interface AiExternalClientStatus {
  id: AiExternalClientId;
  label: string;
  /** Whether the CLI is installed on this machine. */
  installed: boolean;
  /** Whether Runova's server is already in that CLI's own MCP list. */
  connected: boolean;
}
