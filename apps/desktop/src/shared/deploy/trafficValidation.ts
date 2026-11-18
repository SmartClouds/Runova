import type {
  AttackKind,
  AttackSettings,
  AttackThresholds,
  AutoBlockSettings,
  TrafficSettings,
} from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * The limits the core puts on traffic statistics (E109) and attack detection (E110), checked here
 * first so the settings form can say what is wrong before anything is sent. The core checks again
 * and has the last word; these mirror its limits, they do not replace them. Every problem is a
 * sentence the form can show as it is.
 */

export const TRAFFIC_LIMITS = {
  hourlyRetentionDays: [7, 365],
  dailyRetentionDays: [30, 1825],
  eventRetentionDays: [7, 365],
  autoBlockMinutes: [0, 525_600],
  maxBlocked: [1, 100_000],
  maxExcludedSites: 500,
  maxAllowlist: 1000,
  maxReason: 200,
} as const;

/** The core's defaults: what a new server starts with. */
export const DEFAULT_THRESHOLDS: AttackThresholds = {
  scanProbes: 20,
  scanNotFound: 50,
  scanWindowMinutes: 5,
  bruteForceAttempts: 20,
  bruteForceWindowMinutes: 5,
  floodRequestsPerMinute: 600,
  injectionHits: 5,
  injectionWindowMinutes: 10,
};

export const ATTACK_KINDS: ReadonlyArray<{ value: AttackKind; label: string; hint: string }> = [
  {
    value: 'scan',
    label: 'Scans',
    hint: 'Probing for files and admin pages such as /.env, /.git or /phpmyadmin, or many pages that are not there.',
  },
  {
    value: 'bruteForce',
    label: 'Password guessing',
    hint: 'Many logins tried on pages such as /wp-login.php, /login or /admin.',
  },
  {
    value: 'flood',
    label: 'Floods',
    hint: 'One address sending far more requests than people do.',
  },
  {
    value: 'injection',
    label: 'Injection probes',
    hint: 'SQL injection, script injection, path traversal, shell commands or Log4Shell in the address.',
  },
];

export function attackKindLabel(kind: AttackKind): string {
  return ATTACK_KINDS.find((entry) => entry.value === kind)?.label ?? kind;
}

const THRESHOLDS: ReadonlyArray<{
  key: keyof AttackThresholds;
  label: string;
  min: number;
  max: number;
}> = [
  { key: 'scanProbes', label: 'Probe paths', min: 3, max: 10_000 },
  { key: 'scanNotFound', label: 'Not-found answers', min: 5, max: 100_000 },
  { key: 'scanWindowMinutes', label: 'The scan window', min: 1, max: 60 },
  { key: 'bruteForceAttempts', label: 'Login attempts', min: 3, max: 10_000 },
  { key: 'bruteForceWindowMinutes', label: 'The password guessing window', min: 1, max: 60 },
  { key: 'floodRequestsPerMinute', label: 'Requests a minute', min: 60, max: 1_000_000 },
  { key: 'injectionHits', label: 'Injection hits', min: 1, max: 10_000 },
  { key: 'injectionWindowMinutes', label: 'The injection window', min: 1, max: 60 },
];

const SITE_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;
const NETWORK_HINT = 'write an address such as 203.0.113.7 or a range such as 10.0.0.0/8.';

function whole(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isIpv6(text: string): boolean {
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  // An IPv4 address may end it, as in ::ffff:192.0.2.1, and counts as two groups.
  const last = all[all.length - 1];
  const ipv4End = last !== undefined && IPV4.test(last);
  const hex = ipv4End ? all.slice(0, -1) : all;
  if (!hex.every((group) => HEX_GROUP.test(group))) return false;
  const count = hex.length + (ipv4End ? 2 : 0);
  return halves.length === 2 ? count <= 7 : count === 8;
}

export type NetworkCheck = { ok: true; value: string } | { ok: false; reason: string };

/** An IPv4 or IPv6 address, or a CIDR range of either, trimmed and in lower case. */
export function checkNetwork(text: string): NetworkCheck {
  const value = text.trim().toLowerCase();
  const fail: NetworkCheck = { ok: false, reason: `That is not an address: ${NETWORK_HINT}` };
  if (value.length === 0 || value.length > 64) return fail;
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length > 0) return fail;
  const v4 = IPV4.test(address);
  const v6 = !v4 && address.includes(':') && isIpv6(address);
  if (!v4 && !v6) return fail;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (v4 ? 32 : 128)) return fail;
  }
  return { ok: true, value };
}

export function isTimeZone(name: string): boolean {
  if (!name) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function checkTrafficSettings(settings: TrafficSettings): string[] {
  const problems: string[] = [];
  const [hourMin, hourMax] = TRAFFIC_LIMITS.hourlyRetentionDays;
  const [dayMin, dayMax] = TRAFFIC_LIMITS.dailyRetentionDays;
  if (!whole(settings.hourlyRetentionDays, hourMin, hourMax)) {
    problems.push(`Keep hourly figures for ${hourMin} to ${hourMax} days.`);
  }
  if (!whole(settings.dailyRetentionDays, dayMin, dayMax)) {
    problems.push(`Keep daily figures for ${dayMin} to ${dayMax} days.`);
  }
  if (!isTimeZone(settings.timeZone)) problems.push('Pick a time zone from the list.');
  if (settings.excludedSites.length > TRAFFIC_LIMITS.maxExcludedSites) {
    problems.push(`Leave out at most ${TRAFFIC_LIMITS.maxExcludedSites} sites.`);
  } else {
    for (const site of settings.excludedSites) {
      if (!SITE_ID.test(site)) problems.push(`${site} is not a site.`);
    }
  }
  return problems;
}

export function checkAttackSettings(settings: AttackSettings): string[] {
  const problems: string[] = [];
  for (const { key, label, min, max } of THRESHOLDS) {
    if (!whole(settings.thresholds[key], min, max)) {
      problems.push(`${label} must be a whole number from ${min} to ${max}.`);
    }
  }
  if (settings.allowlist.length > TRAFFIC_LIMITS.maxAllowlist) {
    problems.push(`The allowlist takes at most ${TRAFFIC_LIMITS.maxAllowlist} entries.`);
  } else {
    for (const entry of settings.allowlist) {
      if (!checkNetwork(entry).ok) problems.push(`${entry}: ${NETWORK_HINT}`);
    }
  }
  const [eventMin, eventMax] = TRAFFIC_LIMITS.eventRetentionDays;
  if (!whole(settings.eventRetentionDays, eventMin, eventMax)) {
    problems.push(`Keep attack events for ${eventMin} to ${eventMax} days.`);
  }
  return problems;
}

export function checkAutoBlock(settings: AutoBlockSettings): string[] {
  if (!settings.enabled) return [];
  const problems: string[] = [];
  const known = new Set(ATTACK_KINDS.map((kind) => kind.value as string));
  const unknown = settings.kinds.filter((kind) => !known.has(kind));
  if (unknown.length > 0) {
    for (const kind of unknown) problems.push(`${kind} is not a kind of attack.`);
  } else if (settings.kinds.length === 0) {
    problems.push('Pick at least one kind of attack to block.');
  }
  const [minMinutes, maxMinutes] = TRAFFIC_LIMITS.autoBlockMinutes;
  if (!whole(settings.minutes, minMinutes, maxMinutes)) {
    problems.push(`Block for 0 (for good) to ${maxMinutes} minutes.`);
  }
  const [minBlocked, maxBlocked] = TRAFFIC_LIMITS.maxBlocked;
  if (!whole(settings.maxBlocked, minBlocked, maxBlocked)) {
    problems.push(`Cap blocked addresses at ${minBlocked} to ${maxBlocked}.`);
  }
  return problems;
}
