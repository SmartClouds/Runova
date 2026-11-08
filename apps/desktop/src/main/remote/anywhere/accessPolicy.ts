import type { AnywhereSettings } from './settings';

/** What this computer knows about a request when it arrives. */
export interface IncomingFacts {
  mode: 'ask' | 'password';
  relation: 'own' | 'teammate' | 'other';
  controllerUserId: number;
  /** The teams the computer is shown to that the controller is in too, as the server found them. */
  teams: string[];
  hasPasswordSecret: boolean;
  lockedOut: boolean;
}

export type IncomingDecision = 'accept' | 'ask' | 'decline';

/**
 * The computer's own decision on a request (E61). The server already turned away what it could;
 * this is the last word, and it is made here, never on the server.
 *
 * - A password request goes straight to the handshake when a password is set: the handshake itself
 *   checks the password, and a wrong one counts towards the lockout.
 * - The owner's own computers get in without asking only when the owner turned that on.
 * - A teammate gets in without asking only when the owner chose "always allow" for them, and only
 *   while the computer is still shown to a team they share.
 * - Everyone else is declined.
 */
export function decideIncoming(facts: IncomingFacts, settings: AnywhereSettings): IncomingDecision {
  if (!settings.acceptConnections) return 'decline';
  if (facts.mode === 'password') {
    return facts.hasPasswordSecret && !facts.lockedOut ? 'accept' : 'decline';
  }
  if (facts.relation === 'own') return settings.allowOwnDevices ? 'accept' : 'ask';
  if (facts.relation === 'teammate' && facts.teams.length > 0) {
    return settings.alwaysAllow.some((p) => p.userId === facts.controllerUserId) ? 'accept' : 'ask';
  }
  return 'decline';
}

const FIRST_WAIT_MS = 1_000;
const MAX_WAIT_MS = 60_000;
const LOCK_AFTER = 10;
const LOCK_FOR_MS = 15 * 60_000;

/**
 * Slows down password guessing on this computer: 1, 2, 4... seconds after each wrong password,
 * at most a minute, and password access locked for 15 minutes after 10 in a row. This is on top
 * of the server's limit, and it does not depend on the server.
 */
export class PasswordLockout {
  private count = 0;
  private lastFailureAt = 0;
  private until: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  failed(): void {
    this.count++;
    this.lastFailureAt = this.now();
    if (this.count >= LOCK_AFTER) this.until = this.lastFailureAt + LOCK_FOR_MS;
  }

  succeeded(): void {
    this.count = 0;
    this.until = null;
  }

  failures(): number {
    this.expire();
    return this.count;
  }

  /** How long until the next password try is taken. */
  waitMs(): number {
    this.expire();
    if (this.until !== null) return Math.max(0, this.until - this.now());
    if (this.count === 0) return 0;
    const wait = Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (this.count - 1));
    return Math.max(0, this.lastFailureAt + wait - this.now());
  }

  locked(): boolean {
    return this.waitMs() > 0;
  }

  /** When the 15-minute lock ends, or null when password access is not locked. */
  lockedUntil(): number | null {
    this.expire();
    return this.until;
  }

  private expire(): void {
    if (this.until !== null && this.now() >= this.until) {
      this.until = null;
      this.count = 0;
    }
  }
}
