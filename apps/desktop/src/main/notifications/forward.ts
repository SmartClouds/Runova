/**
 * Tells the account's phone that something happened (E82). A notification here is a category and a
 * few short names, never a message: the server writes the one line a phone shows from a template,
 * so terminal output, an agent's words and secrets have no way into a push. Nothing is sent when
 * nobody is signed in on a phone, or the account is signed out of this computer.
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
}

export const MAX_AGENT = 40;
export const MAX_NAME = 80;

/** How long a "someone is listening" answer is kept before asking the server again. */
export const LISTENERS_FOR_MS = 60_000;

/** The server refuses all of these: control and format characters, and shell punctuation. */
const BANNED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}$|<>=\\"`{}[\];*~^%!]/gu;
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A name made safe to send, or undefined when nothing of it is left. */
export function cleanName(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(BANNED, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return cleaned || undefined;
}

export interface NotificationForwarder {
  /** Never throws and never waits: a phone that misses one still has its inbox. */
  forward(event: ForwardEvent): void;
}

export function createNotificationForwarder(deps: ForwarderDeps): NotificationForwarder {
  const now = deps.now ?? (() => Date.now());
  let listeners: { any: boolean; at: number } | null = null;

  async function hasListener(): Promise<boolean> {
    if (listeners && now() - listeners.at < LISTENERS_FOR_MS) return listeners.any;
    const { count } = await deps.api<{ count: number }>(
      'GET',
      '/accounts/me/notification-listeners',
    );
    listeners = { any: count > 0, at: now() };
    return listeners.any;
  }

  async function send(event: ForwardEvent): Promise<void> {
    if (!(await deps.signedIn())) return;
    if (!(await hasListener())) return;
    await deps.api('POST', '/notification-events', {
      category: event.category,
      status: event.status ?? null,
      agent: cleanName(event.agent, MAX_AGENT) ?? null,
      project: cleanName(event.project, MAX_NAME) ?? null,
      subject: cleanName(event.subject, MAX_NAME) ?? null,
      itemId: event.itemId && ITEM_ID.test(event.itemId) ? event.itemId : null,
    });
  }

  return {
    forward(event) {
      void send(event).catch((error: unknown) => {
        deps.log?.(`[notifications] could not forward ${event.category}: ${String(error)}`);
      });
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

/** Passes an event on to the account's phone, when there is one to tell. */
export function forwardNotification(event: ForwardEvent): void {
  forwarder?.forward(event);
}
