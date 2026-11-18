/**
 * Sending files to another device (E112): the messages that travel over a Runova Anywhere link
 * opened with the `send` intent, after the handshake.
 *
 * The sender offers a list of files with `send-offer`. The person at the other end accepts or
 * declines with `send-answer`. On yes, each file then moves with the ordinary `file-*` messages
 * and `BIN_FILE_CHUNK` frames, and the sender ends with `send-complete`. Either side can stop the
 * whole batch with `send-cancel`, and `send-ping` keeps a quiet link from looking dead.
 *
 * The phone's core speaks the same messages, tested against `test-vectors/send-v1.json`, so a
 * change here goes there too.
 */

import { transferKeyFromId } from './index.js';

/** What a device registers when it can take a send. */
export const RECEIVE_FILES_FEATURE = 'receive-files';

/** The part size a send uses: small enough to resend cheaply after a drop. */
export const SEND_PART_BYTES = 4 * 1024 * 1024;

/** How often a send link is pinged, and how long a silent one is given before it counts as dropped. */
export const SEND_PING_MS = 10_000;
export const SEND_SILENCE_MS = 20_000;

export const SEND_LIMITS = {
  maxFiles: 10_000,
  /** The offer as UTF-8, so a list of long paths can not make the other side parse megabytes. */
  maxOfferBytes: 4 * 1024 * 1024,
  /** In characters (code points). */
  maxNoteChars: 500,
  maxPathChars: 1024,
  maxSegments: 32,
  maxSegmentBytes: 255,
  minPartSize: 64 * 1024,
  maxPartSize: 8 * 1024 * 1024,
} as const;

export interface SendFileEntry {
  transferId: string;
  /** A relative path with `/` between folders, ending in the file's name. */
  path: string;
  size: number;
}

export type SendAnswerReason = 'declined' | 'busy' | 'timeout' | 'not-allowed' | 'no-space';

const ANSWER_REASONS: readonly SendAnswerReason[] = [
  'declined',
  'busy',
  'timeout',
  'not-allowed',
  'no-space',
];

export type SendMessage =
  | { t: 'send-offer'; v: 1; batchId: string; files: SendFileEntry[]; note?: string }
  | {
      t: 'send-answer';
      batchId: string;
      accept: boolean;
      reason?: SendAnswerReason;
      /** The receiver already has this batch from a link that dropped; it does not ask again. */
      resumed?: boolean;
      /** Transfers the receiver already saved, so they are not sent twice. */
      finished?: string[];
    }
  | { t: 'send-cancel'; batchId: string; reason?: string }
  | { t: 'send-ping' }
  | { t: 'send-complete'; batchId: string };

/** True for a decoded control message that belongs to the send protocol. */
export function isSendMessage(value: unknown): value is { t: SendMessage['t'] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string' &&
    (value as { t: string }).t.startsWith('send-')
  );
}

/** Reads one send message, or null when it is malformed or breaks a limit. Unknown fields are dropped. */
export function parseSendMessage(text: string): SendMessage | null {
  if (text.length > SEND_LIMITS.maxOfferBytes || utf8Length(text) > SEND_LIMITS.maxOfferBytes) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case 'send-offer':
      return readOffer(m);
    case 'send-answer':
      return readAnswer(m);
    case 'send-cancel': {
      if (!isId(m.batchId)) return null;
      if (m.reason === undefined) return { t: 'send-cancel', batchId: m.batchId };
      return isNote(m.reason) ? { t: 'send-cancel', batchId: m.batchId, reason: m.reason } : null;
    }
    case 'send-ping':
      return { t: 'send-ping' };
    case 'send-complete':
      return isId(m.batchId) ? { t: 'send-complete', batchId: m.batchId } : null;
    default:
      return null;
  }
}

/** Writes a send message with its fields in the order the vectors pin. */
export function encodeSendMessage(message: SendMessage): string {
  return JSON.stringify(message);
}

function readOffer(m: Record<string, unknown>): SendMessage | null {
  if (m.v !== 1 || !isId(m.batchId) || !Array.isArray(m.files)) return null;
  if (m.files.length === 0 || m.files.length > SEND_LIMITS.maxFiles) return null;
  if (m.note !== undefined && !isNote(m.note)) return null;
  const ids = new Set<string>();
  const keys = new Set<number>();
  const paths = new Set<string>();
  const files: SendFileEntry[] = [];
  for (const entry of m.files as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { transferId, path, size } = entry as Record<string, unknown>;
    if (!isId(transferId) || typeof path !== 'string' || !isSize(size)) return null;
    const target = safeRelativePath(path);
    if (target === null) return null;
    const key = transferKeyFromId(transferId);
    const pathKey = sendPathKey(target);
    // Two files that would land on the same name, or share a chunk key, can not both be told apart.
    if (ids.has(transferId) || keys.has(key) || paths.has(pathKey)) return null;
    ids.add(transferId);
    keys.add(key);
    paths.add(pathKey);
    files.push({ transferId, path, size });
  }
  return m.note === undefined
    ? { t: 'send-offer', v: 1, batchId: m.batchId, files }
    : { t: 'send-offer', v: 1, batchId: m.batchId, files, note: m.note as string };
}

function readAnswer(m: Record<string, unknown>): SendMessage | null {
  if (!isId(m.batchId) || typeof m.accept !== 'boolean') return null;
  const answer: Extract<SendMessage, { t: 'send-answer' }> = {
    t: 'send-answer',
    batchId: m.batchId,
    accept: m.accept,
  };
  if (m.reason !== undefined) {
    if (!ANSWER_REASONS.includes(m.reason as SendAnswerReason)) return null;
    answer.reason = m.reason as SendAnswerReason;
  }
  if (m.resumed !== undefined) {
    if (typeof m.resumed !== 'boolean') return null;
    answer.resumed = m.resumed;
  }
  if (m.finished !== undefined) {
    if (
      !Array.isArray(m.finished) ||
      m.finished.length > SEND_LIMITS.maxFiles ||
      !m.finished.every(isId)
    ) {
      return null;
    }
    answer.finished = m.finished as string[];
  }
  return answer;
}

// --- Paths -------------------------------------------------------------------------

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const NOT_ON_WINDOWS = /[<>:"|?*]/g;
const DRIVE = /^[A-Za-z]:/;

/**
 * Where a file in an offer may go, as a relative path with `/` between parts, or null when the
 * path tries to leave the folder it is saved in.
 *
 * Turned down: an empty path or part, `.` and `..`, a leading `/`, a drive letter, a backslash,
 * control characters, more than 32 parts, a part over 255 bytes, and over 1024 characters.
 * Mended, so the same path is safe on every system: characters Windows forbids become `_`,
 * trailing dots and spaces go, and the names Windows keeps for devices (`CON`, `nul.txt`, `LPT1`)
 * get a `_` after the name.
 */
export function safeRelativePath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > SEND_LIMITS.maxPathChars) {
    return null;
  }
  if (hasControl(path) || path.includes('\\') || path.startsWith('/') || DRIVE.test(path)) {
    return null;
  }
  const parts = path.split('/');
  if (parts.length > SEND_LIMITS.maxSegments) return null;
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
    const mended = mendPart(part);
    if (utf8Length(mended) > SEND_LIMITS.maxSegmentBytes) return null;
    out.push(mended);
  }
  return out.join('/');
}

/** A path as compared for clashes: case does not count, as on Windows and macOS. */
export function sendPathKey(path: string): string {
  return path.toLowerCase();
}

function mendPart(part: string): string {
  const trimmed = part.replace(NOT_ON_WINDOWS, '_').replace(/[. ]+$/, '');
  if (trimmed === '') return '_';
  const dot = trimmed.indexOf('.');
  const stem = dot === -1 ? trimmed : trimmed.slice(0, dot);
  return RESERVED.test(stem) ? `${stem}_${trimmed.slice(stem.length)}` : trimmed;
}

// --- Small checks ------------------------------------------------------------------

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNote(value: unknown): value is string {
  return typeof value === 'string' && codePoints(value) <= SEND_LIMITS.maxNoteChars;
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
