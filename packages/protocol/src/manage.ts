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
