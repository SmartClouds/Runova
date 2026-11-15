import type {
  EmailGateInput,
  EmailGatePeople,
  EmailGateSession,
  EmailGateSettings,
} from '../cloudflareTypes';

/**
 * The email code gate (E96): Cloudflare Access in front of a hostname. A visitor types their email,
 * Cloudflare mails a code, and only the people listed get in. The dialog checks a gate with this
 * as the user types, and the main process checks it again before it goes to Cloudflare.
 */

/** Kept well under what one Access policy holds, so the list stays something a person can read. */
export const MAX_EMAIL_GATE_PEOPLE = 100;

export const EMAIL_GATE_SESSIONS: readonly {
  value: EmailGateSession;
  label: string;
  /** For sentences: "for 24 hours". */
  words: string;
}[] = [
  { value: '30m', label: '30 min', words: '30 minutes' },
  { value: '6h', label: '6 hours', words: '6 hours' },
  { value: '24h', label: '24 hours', words: '24 hours' },
  { value: '168h', label: '7 days', words: '7 days' },
  { value: '720h', label: '30 days', words: '30 days' },
];

export const DEFAULT_EMAIL_GATE_SESSION: EmailGateSession = '24h';

/** Let's Encrypt's HTTP-01 checks come here, so it stays open for renewals. */
export const ACME_CHALLENGE_PATH = '/.well-known/acme-challenge';

export type PeopleEntry =
  | { kind: 'email'; value: string }
  | { kind: 'domain'; value: string }
  | { kind: 'invalid'; value: string; reason: string };

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,63}$`);
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;
const HOSTNAME = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,63}$`);
const TEAM = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isEmailGateSession(value: unknown): value is EmailGateSession {
  return EMAIL_GATE_SESSIONS.some((session) => session.value === value);
}

function sessionWords(session: EmailGateSession): string {
  return EMAIL_GATE_SESSIONS.find((option) => option.value === session)?.words ?? session;
}

export function isEmailAddress(value: string): boolean {
  const at = value.lastIndexOf('@');
  if (at <= 0 || value.indexOf('@') !== at) return false;
  return LOCAL.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1));
}

export function isEmailDomain(value: string): boolean {
  return DOMAIN.test(value);
}

/** One typed or pasted entry: an address, a whole domain (with or without @), or why neither. */
export function parsePeopleEntry(raw: string): PeopleEntry {
  let value = raw.trim();
  const named = value.match(/<([^<>]+)>\s*$/);
  if (named?.[1]) value = named[1].trim();
  value = value.toLowerCase();
  if (value.includes('@') && !value.startsWith('@')) {
    return isEmailAddress(value)
      ? { kind: 'email', value }
      : { kind: 'invalid', value: raw.trim(), reason: 'This is not an email address.' };
  }
  const domain = value.replace(/^@/, '');
  if (isEmailDomain(domain)) return { kind: 'domain', value: domain };
  return {
    kind: 'invalid',
    value: raw.trim(),
    reason: 'Type an email address, or a domain like @company.com to let in everyone there.',
  };
}

/**
 * Pasted text split into entries on commas, semicolons, spaces and new lines. A "Name <address>"
 * entry from a mail app stays together, and repeats are dropped.
 */
export function parsePeople(text: string): PeopleEntry[] {
  // A display name has no @ in it, so "a@x.io Ana <b@y.io>" still splits into two.
  const pieces = text.match(/[^,;\n<>@]*<[^<>]+>|[^\s,;]+/g) ?? [];
  const seen = new Set<string>();
  const entries: PeopleEntry[] = [];
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    const entry = parsePeopleEntry(piece);
    const key = `${entry.kind}:${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

export function hostnameInZone(hostname: string, zoneName: string): boolean {
  const name = hostname.toLowerCase();
  const zone = zoneName.toLowerCase();
  return name === zone || name.endsWith(`.${zone}`);
}

export function peopleCount(people: EmailGatePeople): number {
  return people.emails.length + people.emailDomains.length;
}

/** The first problem with a gate, in words, or null when Cloudflare can take it. */
export function validateEmailGateInput(input: EmailGateInput, zoneName: string): string | null {
  const hostname = input.hostname.toLowerCase();
  if (!HOSTNAME.test(hostname)) {
    return 'The email code gate goes on one hostname, with no wildcard or path.';
  }
  if (!hostnameInZone(hostname, zoneName)) return `${hostname} is not in ${zoneName}.`;
  if (peopleCount(input) === 0) {
    return 'Add at least one email address or domain, so someone can get in.';
  }
  if (peopleCount(input) > MAX_EMAIL_GATE_PEOPLE) {
    return `Keep the list to ${MAX_EMAIL_GATE_PEOPLE} addresses and domains. A whole domain covers everyone there.`;
  }
  const badEmail = input.emails.find((email) => !isEmailAddress(email));
  if (badEmail !== undefined) return `${badEmail} is not an email address.`;
  const badDomain = input.emailDomains.find((domain) => !isEmailDomain(domain));
  if (badDomain !== undefined) return `${badDomain} is not a domain.`;
  if (!isEmailGateSession(input.session)) return 'Pick how long people stay in after the code.';
  return null;
}

/** A Zero Trust team name, the first part of team.cloudflareaccess.com. */
export function validateTeamName(value: string): string | null {
  if (!value) return 'Pick a team name.';
  if (value !== value.toLowerCase()) return 'Use lower case letters, digits and dashes.';
  if (!TEAM.test(value)) {
    return 'Use lower case letters, digits and dashes, not at the start or end, up to 63 characters.';
  }
  return null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The row's chip: "Email code, 3 people, 24 hours". */
export function emailGateSummary(settings: EmailGateSettings): string {
  return `Email code, ${plural(peopleCount(settings), 'person', 'people')}, ${sessionWords(settings.session)}`;
}

/** The dialog's live sentence on who gets in and for how long. */
export function emailGatePreview(settings: EmailGateSettings, hostname: string): string {
  const named = [
    ...settings.emailDomains.map((domain) => `Anyone at @${domain}`),
    ...settings.emails,
  ];
  if (named.length === 0)
    return `Add at least one email or domain to say who can open ${hostname}.`;
  const [first, second] = named;
  let who: string;
  if (named.length === 1) who = String(first);
  else if (named.length === 2) who = `${first} and ${second}`;
  else who = `${first} and ${plural(named.length - 1, 'more person', 'more people')}`;
  return `${who} can open ${hostname} for ${sessionWords(settings.session)} after typing a code.`;
}

const PREFIX = 'Runova, ';
const BYPASS_SUFFIX = ', certificate checks';

/** Names of the Access applications the app makes, so it finds its own again and no others. */
export const emailGateApp = {
  name: (hostname: string): string => `${PREFIX}${hostname}`.slice(0, 200),
  bypassName: (hostname: string): string => `${PREFIX}${hostname}${BYPASS_SUFFIX}`.slice(0, 200),
  isOurs: (app: { name?: string | null }): boolean =>
    !!app.name?.startsWith(PREFIX) && !app.name.endsWith(BYPASS_SUFFIX),
  isOurBypass: (app: { name?: string | null }): boolean =>
    !!app.name?.startsWith(PREFIX) && app.name.endsWith(BYPASS_SUFFIX),
};

export function emailGateBypassDomain(hostname: string): string {
  return `${hostname}${ACME_CHALLENGE_PATH}`;
}

/** Where an Access application is in Cloudflare's Zero Trust dashboard. */
export function accessDashboardUrl(cloudflareAccountId: string, appId?: string): string {
  const base = `https://one.dash.cloudflare.com/${encodeURIComponent(cloudflareAccountId)}/access/apps`;
  return appId ? `${base}/edit/${encodeURIComponent(appId)}` : base;
}
