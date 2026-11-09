import { composePushLine } from './pushLines';
import { sealItem, sealKeyId } from './sealedItem';

/**
 * Tells the account's phone that something happened (E82). A notification here is a category and a
 * few short names, never a message: the server writes the one line a phone shows from a template,
 * so terminal output, an agent's words and secrets have no way into a push. Nothing is sent when
 * nobody is signed in on a phone, or the account is signed out of this computer.
 *
 * With encrypted notifications on (E92) this computer writes the line from the same templates and
 * seals one copy for each phone, so the server gets the category and nothing it can read.
 */

export type ForwardCategory =
  | 'agent-needs-input'
  | 'agent-finished'
  | 'tasks'
  | 'pipelines'
  | 'deploys'
  | 'monitors'
  | 'relay'
  | 'ai-limits'
  | 'security-news'
  | 'tool-updates'
  | 'remote';

export interface ForwardEvent {
  category: ForwardCategory;
  /** Which template of the category applies; the server knows the list. */
  status?: string;
  agent?: string;
  project?: string;
  subject?: string;
  /** This computer's id of the project or target. */
  itemId?: string;
}

export interface ForwarderDeps {
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  signedIn: () => Promise<boolean>;
  now?: () => number;
  log?: (message: string) => void;
  /** Public keys of the phones approved here, the most recently seen first. */
  sealKeys?: () => Promise<string[]>;
}

export const MAX_AGENT = 40;
export const MAX_NAME = 80;

/** How long a "someone is listening" answer is kept before asking the server again. */
export const LISTENERS_FOR_MS = 60_000;

/** The server refuses all of these: control and format characters, and shell punctuation. */
const BANNED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}$|<>=\\"`{}[\];*~^%!]/gu;
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_COPIES = 8;
const PUBLIC_KEY_BYTES = 32;

/** A name made safe to send, or undefined when nothing of it is left. */
export function cleanName(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(BANNED, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return cleaned || undefined;
}

export interface NotificationForwarder {
  /** Never throws and never waits: a phone that misses one still has its inbox. */
  forward(event: ForwardEvent): void;
  /** Forgets what the server last said, after a switch changed here. */
  refresh(): void;
}

function copyFor(publicKey: string, line: string, context: string) {
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== PUBLIC_KEY_BYTES) return null;
  try {
    const sealed = sealItem(raw, Buffer.from(line, 'utf8'), context);
    return { keyId: sealKeyId(raw), sealed: sealed.toString('base64url') };
  } catch {
    return null;
  }
}

function refusedByPlan(error: unknown): boolean {
  return (error as { problem?: { status?: number } }).problem?.status === 403;
}

export function createNotificationForwarder(deps: ForwarderDeps): NotificationForwarder {
  const now = deps.now ?? (() => Date.now());
  let listeners: { any: boolean; sealing: boolean; at: number } | null = null;

  async function readListeners(): Promise<{ any: boolean; sealing: boolean }> {
    if (listeners && now() - listeners.at < LISTENERS_FOR_MS) return listeners;
    const { count, sealing } = await deps.api<{ count: number; sealing?: boolean }>(
      'GET',
      '/accounts/me/notification-listeners',
    );
    listeners = { any: count > 0, sealing: sealing === true, at: now() };
    return listeners;
  }

  /** False only when the plan turned it down, which is the one time plain text may follow. */
  async function sendSealed(event: ForwardEvent, itemId: string | null): Promise<boolean> {
    const line = composePushLine({
      category: event.category,
      status: event.status,
      agent: cleanName(event.agent, MAX_AGENT),
      project: cleanName(event.project, MAX_NAME),
      subject: cleanName(event.subject, MAX_NAME),
    });
    if (line === null) {
      deps.log?.(`[notifications] no wording for ${event.category} ${event.status ?? ''}`);
      return true;
    }
    const context = `notification:${event.category}`;
    const keys = (await deps.sealKeys?.()) ?? [];
    const copies = keys
      .map((key) => copyFor(key, line, context))
      .filter((copy) => copy !== null)
      .slice(0, MAX_COPIES);
    try {
      await deps.api('POST', '/notification-events', {
        category: event.category,
        itemId,
        sealedFor: copies,
      });
      return true;
    } catch (error) {
      if (!refusedByPlan(error)) throw error;
      listeners = null;
      return false;
    }
  }

  async function send(event: ForwardEvent): Promise<void> {
    if (!(await deps.signedIn())) return;
    const heard = await readListeners();
    if (!heard.any) return;
    const itemId = event.itemId && ITEM_ID.test(event.itemId) ? event.itemId : null;
    if (heard.sealing && (await sendSealed(event, itemId))) return;
    await deps.api('POST', '/notification-events', {
      category: event.category,
      status: event.status ?? null,
      agent: cleanName(event.agent, MAX_AGENT) ?? null,
      project: cleanName(event.project, MAX_NAME) ?? null,
      subject: cleanName(event.subject, MAX_NAME) ?? null,
      itemId,
    });
  }

  return {
    forward(event) {
      void send(event).catch((error: unknown) => {
        deps.log?.(`[notifications] could not forward ${event.category}: ${String(error)}`);
      });
    },
    refresh() {
      listeners = null;
    },
  };
}

let forwarder: NotificationForwarder | null = null;

/** Called once the account runtime exists; until then a notification goes nowhere. */
export function startNotificationForwarding(deps: ForwarderDeps): void {
  forwarder = createNotificationForwarder(deps);
}

/** Forgets the forwarder, for tests. */
export function stopNotificationForwarding(): void {
  forwarder = null;
}

/** Picks up a change to the encryption switch without waiting for the next check. */
export function refreshNotificationForwarding(): void {
  forwarder?.refresh();
}

/** Passes an event on to the account's phone, when there is one to tell. */
export function forwardNotification(event: ForwardEvent): void {
  forwarder?.forward(event);
}
