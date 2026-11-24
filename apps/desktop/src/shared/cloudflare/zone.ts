import type { CloudflareSslMode } from '../cloudflareTypes';

/**
 * Zone-wide helpers the settings card and the "point domain" dialog share: which SSL/TLS mode a
 * proxied domain should use, and the URL list for a cache purge.
 */

/** How many files Cloudflare purges in one request on most plans. */
export const PURGE_URL_LIMIT = 30;

/**
 * The browser cache TTLs Cloudflare accepts, in seconds. 0 means "respect existing headers". Some
 * of the short ones need a paid plan, and Cloudflare says so when a plan cannot use them.
 */
export const BROWSER_CACHE_TTLS: readonly number[] = [
  0, 30, 60, 120, 300, 1200, 1800, 3600, 7200, 10800, 14400, 18000, 28800, 43200, 57600, 72000,
  86400, 172800, 259200, 345600, 432000, 691200, 1382400, 2073600, 2678400, 5356800, 16070400,
  31536000,
];
const MAX_URL = 2048;

export interface SslAdvice {
  level: 'ok' | 'improve' | 'warning';
  recommended: CloudflareSslMode;
  message: string;
}

const STRICT_NEEDS =
  "Full (strict) needs a trusted certificate on the server, such as one from Let's Encrypt.";

/**
 * What a proxied domain's SSL/TLS mode means for its visitors, and the mode to move to. The mode
 * is zone wide and only applies to proxied records; DNS-only records reach the server directly.
 */
export function sslAdvice(mode: CloudflareSslMode): SslAdvice {
  switch (mode) {
    case 'strict':
    case 'origin_pull':
      return {
        level: 'ok',
        recommended: mode,
        message:
          "Cloudflare encrypts the connection to your server and checks the server's certificate. This is the safest mode.",
      };
    case 'full':
      return {
        level: 'improve',
        recommended: 'strict',
        message: `The connection to your server is encrypted, but its certificate is not checked, so anyone in between could pose as it. ${STRICT_NEEDS}`,
      };
    case 'flexible':
      return {
        level: 'warning',
        recommended: 'strict',
        message: `Cloudflare reaches your server over plain HTTP, and a server that redirects to HTTPS sends visitors round in a loop. ${STRICT_NEEDS}`,
      };
    default:
      return {
        level: 'warning',
        recommended: 'strict',
        message: `Visitors get no HTTPS at all. ${STRICT_NEEDS}`,
      };
  }
}

export type PurgeUrlsCheck = { ok: true; urls: string[] } | { ok: false; problem: string };
export type PurgeListCheck = { ok: true; items: string[] } | { ok: false; problem: string };

/** One label of a hostname: letters, digits and inner dashes. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCHEME = /^https?:\/\//i;

/** The non-blank lines of a list, trimmed, each once, in the order typed. */
function listLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/** Why a list of `noun`s cannot go out as it stands, or null when its size is fine. */
function listSizeProblem(lines: string[], noun: string): string | null {
  if (lines.length === 0) return `Enter at least one ${noun} to purge.`;
  if (lines.length > PURGE_URL_LIMIT) {
    return `Cloudflare purges up to ${PURGE_URL_LIMIT} ${noun}s at a time.`;
  }
  return null;
}

/** A hostname with at least two labels, such as www.example.com. No wildcards. */
function isHostname(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((label) => HOST_LABEL.test(label));
}

/** The domain itself or any name under it, so a purge never aims at someone else's site. */
function underZone(host: string, zoneName: string): boolean {
  const zone = zoneName.toLowerCase();
  return host === zone || host.endsWith(`.${zone}`);
}

/**
 * The URLs to purge, one per line, as full http or https addresses. Given the domain's name, a
 * URL on another domain is refused, since Cloudflare would quietly purge nothing.
 */
export function checkPurgeUrls(text: string, zoneName?: string): PurgeUrlsCheck {
  const lines = listLines(text);
  const sizeProblem = listSizeProblem(lines, 'URL');
  if (sizeProblem) return { ok: false, problem: sizeProblem };
  for (const line of lines) {
    let url: URL | null = null;
    try {
      url = new URL(line);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return {
        ok: false,
        problem: `${line} is not a full web address. Start it with https://.`,
      };
    }
    if (line.length > MAX_URL) {
      return { ok: false, problem: `Keep each URL under ${MAX_URL} characters.` };
    }
    if (zoneName && !underZone(url.hostname, zoneName)) {
      return { ok: false, problem: `${line} is not under ${zoneName}.` };
    }
  }
  return { ok: true, urls: lines };
}

/**
 * The folders to purge, one per line, as a name and a path (example.com/blog/). Cloudflare takes
 * them without a scheme, so one pasted with https:// loses it, and the name goes to lower case.
 * The path keeps its case, since paths are case sensitive.
 */
export function checkPurgePrefixes(text: string, zoneName?: string): PurgeListCheck {
  const lines = listLines(text).map((line) => {
    const bare = line.replace(SCHEME, '');
    const slash = bare.indexOf('/');
    return slash === -1
      ? bare.toLowerCase()
      : bare.slice(0, slash).toLowerCase() + bare.slice(slash);
  });
  const items = [...new Set(lines)];
  const sizeProblem = listSizeProblem(items, 'folder');
  if (sizeProblem) return { ok: false, problem: sizeProblem };
  for (const item of items) {
    if (item.length > MAX_URL) {
      return { ok: false, problem: `Keep each folder under ${MAX_URL} characters.` };
    }
    if (/[?#]/.test(item)) {
      return {
        ok: false,
        problem: `${item} has a query or a #. Keep just the name and the folder.`,
      };
    }
    const slash = item.indexOf('/');
    const host = slash === -1 ? item : item.slice(0, slash);
    const path = slash === -1 ? '' : item.slice(slash);
    if (!isHostname(host) || /\s/.test(path)) {
      return {
        ok: false,
        problem: `${item} is not a folder address. Write it like example.com/blog/.`,
      };
    }
    if (path === '' || path === '/') {
      return {
        ok: false,
        problem: `${item} is a whole hostname. Add a folder after it, like ${host}/blog/, or pick Hostnames.`,
      };
    }
    if (zoneName && !underZone(host, zoneName)) {
      return { ok: false, problem: `${item} is not under ${zoneName}.` };
    }
  }
  return { ok: true, items };
}

/**
 * The hostnames to purge, one per line (www.example.com). One pasted as an address loses its
 * scheme and closing slash; one with a path is a folder, so the problem says to pick Folders.
 */
export function checkPurgeHosts(text: string, zoneName?: string): PurgeListCheck {
  const items = [
    ...new Set(
      listLines(text).map((line) => line.replace(SCHEME, '').replace(/\/$/, '').toLowerCase()),
    ),
  ];
  const sizeProblem = listSizeProblem(items, 'hostname');
  if (sizeProblem) return { ok: false, problem: sizeProblem };
  for (const item of items) {
    if (item.includes('/')) {
      return { ok: false, problem: `${item} is a folder. Pick Folders to purge it.` };
    }
    if (!isHostname(item)) {
      return {
        ok: false,
        problem: `${item} is not a hostname. Write it like www.example.com.`,
      };
    }
    if (zoneName && !underZone(item, zoneName)) {
      return { ok: false, problem: `${item} is not under ${zoneName}.` };
    }
  }
  return { ok: true, items };
}
