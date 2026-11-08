/**
 * Managing a computer from a phone (E71): calls and subscriptions over a secure link. Every method
 * a phone can reach is named in {@link MANAGE_METHODS} with its scope and risk, so nothing outside
 * this table is reachable, whatever a phone sends. `test-vectors/manage-v1.json` pins the wire
 * format for the Rust core.
 */

export const MANAGE_VERSION = 1;
export const MANAGE_CAPABILITY = 'manage/1';

export type ManageScope =
  | 'core'
  | 'terminal'
  | 'git'
  | 'vault'
  | 'deploy'
  | 'ops'
  | 'control'
  | 'files';

/** `read` changes nothing, `write` changes something, `danger` is hard to undo. */
export type ManageRisk = 'read' | 'write' | 'danger';

export interface ManageMethod {
  scope: ManageScope;
  risk: ManageRisk;
}

/** Scopes a person can switch per phone. `core` comes with being trusted. */
export const MANAGE_GRANTABLE_SCOPES: readonly ManageScope[] = [
  'terminal',
  'git',
  'vault',
  'deploy',
  'ops',
  'control',
  'files',
];

export const MANAGE_METHODS: Record<string, ManageMethod> = {
  'projects.list': { scope: 'core', risk: 'read' },
  'terminals.list': { scope: 'terminal', risk: 'read' },
  'terminals.follow': { scope: 'terminal', risk: 'read' },
  'terminals.write': { scope: 'terminal', risk: 'write' },
  'terminals.processes': { scope: 'terminal', risk: 'read' },
  'git.state': { scope: 'git', risk: 'read' },
  'git.diff': { scope: 'git', risk: 'read' },
  'git.branches': { scope: 'git', risk: 'read' },
  'git.stashes': { scope: 'git', risk: 'read' },
  'git.stage': { scope: 'git', risk: 'write' },
  'git.unstage': { scope: 'git', risk: 'write' },
  'git.commit': { scope: 'git', risk: 'write' },
  'git.fetch': { scope: 'git', risk: 'write' },
  'git.pull': { scope: 'git', risk: 'write' },
  'git.push': { scope: 'git', risk: 'write' },
  'git.checkout': { scope: 'git', risk: 'write' },
  'git.createBranch': { scope: 'git', risk: 'write' },
  'git.stashPush': { scope: 'git', risk: 'write' },
  'git.stashPop': { scope: 'git', risk: 'write' },
  'git.resolve': { scope: 'git', risk: 'write' },
  'git.discard': { scope: 'git', risk: 'danger' },
  'git.deleteBranch': { scope: 'git', risk: 'danger' },
  'git.stashDrop': { scope: 'git', risk: 'danger' },
  'git.abort': { scope: 'git', risk: 'danger' },
  'status.system': { scope: 'core', risk: 'read' },
  'status.usage': { scope: 'core', risk: 'read' },
  'vault.status': { scope: 'vault', risk: 'read' },
  'vault.unlock': { scope: 'vault', risk: 'write' },
  'vault.lock': { scope: 'vault', risk: 'write' },
  'vault.list': { scope: 'vault', risk: 'read' },
  'vault.reveal': { scope: 'vault', risk: 'danger' },
  'vault.save': { scope: 'vault', risk: 'write' },
  'vault.remove': { scope: 'vault', risk: 'danger' },
  'deploy.servers': { scope: 'deploy', risk: 'read' },
  'deploy.overview': { scope: 'deploy', risk: 'read' },
  'deploy.containerLogs': { scope: 'deploy', risk: 'read' },
  'deploy.containerAction': { scope: 'deploy', risk: 'danger' },
  'deploy.stackAction': { scope: 'deploy', risk: 'danger' },
  'deploy.stackRedeploy': { scope: 'deploy', risk: 'danger' },
};

/** A project as a phone shows it: no paths, prompts or environment. */
export interface ManageProject {
  id: string;
  name: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  iconBgColor: string | null;
  iconColor: string | null;
  hasRepository: boolean;
}

/** A running terminal or CLI. */
export interface ManageTerminal {
  sessionId: string;
  title: string;
  projectId: string | null;
  cliId: string | null;
  /** What its agent is doing, when an agent runs in it. */
  status: 'idle' | 'working' | 'needs-input' | 'done' | 'exited' | null;
  createdAt: number;
}

export interface ManageTerminalProcess {
  name: string;
  cpuPercent: number;
  memBytes: number;
}

export interface ManageGitDiffLine {
  kind: 'hunk' | 'ctx' | 'add' | 'del';
  text: string;
}

/** Worked out on the computer, so a phone never has to hold two versions of a file. */
export interface ManageGitDiff {
  path: string;
  binary: boolean;
  tooLarge: boolean;
  lines: ManageGitDiffLine[];
}

export interface ManageGitBranch {
  name: string;
  current: boolean;
  local: boolean;
}

export interface ManageGitStash {
  ref: string;
  message: string;
}

export interface ManageSystemStats {
  cpuModel: string;
  cpuCoreCount: number;
  cpuPercent: number;
  memPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
}

export interface ManageUsageLimit {
  providerId: string;
  name: string;
  plan: string | null;
  state: 'ok' | 'estimate' | 'stale' | 'unavailable';
  problem: string | null;
  /** `resetInMs` is measured on the computer, since a phone's clock may disagree with it. */
  windows: { label: string; percent: number; resetInMs: number | null }[];
}

export interface ManageProviderUsage {
  providerId: string;
  name: string;
  status: 'ok' | 'connect' | 'error';
  error: string | null;
  todayUsd: number | null;
  weekUsd: number | null;
  monthUsd: number | null;
  series: number[];
}

export interface ManageUsage {
  limits: ManageUsageLimit[];
  providers: ManageProviderUsage[];
}

/** An entry as a phone lists it: which secrets exist, never what they are. */
export interface ManageVaultEntry {
  id: string;
  type: string;
  title: string;
  username: string;
  service: string;
  host: string;
  favorite: boolean;
  hasPassword: boolean;
  hasTotp: boolean;
  hasSecret: boolean;
  hasNotes: boolean;
  fields: { id: string; label: string; concealed: boolean; hasValue: boolean }[];
}

export interface ManageDeployServer {
  id: string;
  name: string;
  host: string;
  state: string;
  problem: string | null;
}

export interface ManageDeployOverview {
  reachable: boolean;
  version: string | null;
  containers: {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    health: string | null;
  }[];
  stacks: {
    id: string;
    name: string;
    status: string;
    running: number;
    total: number;
    canRedeploy: boolean;
  }[];
  problems: { id: string; severity: 'critical' | 'warning'; title: string; detail: string }[];
  lastBackup: { state: string; planName: string | null; error: string | null } | null;
}

export interface ManageDeployLogLine {
  text: string;
  error: boolean;
}

export type ManageErrorCode = 'unknown-method' | 'forbidden' | 'bad-params' | 'busy' | 'failed';

export type ManageMessage =
  | { t: 'manage-ready'; v: number; deviceName: string; scopes: ManageScope[] }
  | { t: 'rpc-call'; id: number; m: string; p?: unknown }
  | { t: 'rpc-result'; id: number; ok: true; v?: unknown }
  | { t: 'rpc-result'; id: number; ok: false; code: ManageErrorCode; message: string }
  | { t: 'rpc-sub'; id: number; m: string; p?: unknown }
  | { t: 'rpc-unsub'; id: number }
  | { t: 'rpc-event'; id: number; v: unknown }
  | { t: 'rpc-end'; id: number; code?: ManageErrorCode; message?: string };

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The message, or null for anything that is not exactly one of the shapes above. */
export function parseManageMessage(text: string): ManageMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message.t) {
    case 'manage-ready':
      return isId(message.v) &&
        typeof message.deviceName === 'string' &&
        Array.isArray(message.scopes)
        ? (message as unknown as ManageMessage)
        : null;
    case 'rpc-call':
    case 'rpc-sub':
      return isId(message.id) && isText(message.m) ? (message as unknown as ManageMessage) : null;
    case 'rpc-unsub':
      return isId(message.id) ? (message as unknown as ManageMessage) : null;
    case 'rpc-result':
      if (!isId(message.id)) return null;
      if (message.ok === true) return message as unknown as ManageMessage;
      return message.ok === false && isText(message.code) && typeof message.message === 'string'
        ? (message as unknown as ManageMessage)
        : null;
    case 'rpc-event':
      return isId(message.id) && 'v' in message ? (message as unknown as ManageMessage) : null;
    case 'rpc-end':
      return isId(message.id) ? (message as unknown as ManageMessage) : null;
    default:
      return null;
  }
}

export function encodeManageMessage(message: ManageMessage): string {
  return JSON.stringify(message);
}

const STREAM_KIND = 1;
const STREAM_HEADER = 5;

/** A subscription's raw bytes, such as terminal output: `[kind u8][subscription u32 BE][bytes]`. */
export function encodeManageStream(subscription: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(STREAM_HEADER + payload.length);
  frame[0] = STREAM_KIND;
  new DataView(frame.buffer).setUint32(1, subscription, false);
  frame.set(payload, STREAM_HEADER);
  return frame;
}

export function decodeManageStream(
  frame: Uint8Array,
): { subscription: number; payload: Uint8Array } | null {
  if (frame.length < STREAM_HEADER || frame[0] !== STREAM_KIND) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { subscription: view.getUint32(1, false), payload: frame.subarray(STREAM_HEADER) };
}
