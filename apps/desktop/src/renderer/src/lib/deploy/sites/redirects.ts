import type { SiteDraft } from './draft';

/**
 * Redirects in the site editor: checking a destination the way the core does (so a mistake shows
 * before saving), an example of where a request ends up, and the one-click www suggestion.
 */

const MAX_LENGTH = 2048;

/** What nginx can take inside a bare token: never whitespace, quotes, a semicolon, braces or $. */
const PATH_CHARACTER = /^[A-Za-z0-9\-._~/%!*+,=:@&?]$/;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A name covers a host exactly, or as a wildcard for any name below it (as nginx reads it). */
export function covers(name: string, host: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.startsWith('*.') ? host.endsWith(lower.slice(1)) : host === lower;
}

function describe(char: string): string {
  if (/\s/.test(char)) return 'spaces';
  if (char === '"' || char === "'") return 'quotes';
  if (char === ';') return 'a semicolon';
  return char;
}

function hostProblem(authority: string): { host: string; problem?: string } {
  let host: string;
  let port: string | undefined;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    host = close < 0 ? '' : authority.slice(1, close).toLowerCase();
    if (close < 0 || !/^[0-9a-f:.]+$/.test(host) || !host.includes(':')) {
      return {
        host,
        problem: `${authority} is not an IPv6 address in brackets.`,
      };
    }
    const after = authority.slice(close + 1);
    if (after !== '' && !after.startsWith(':')) {
      return { host, problem: `${authority} is not a host and port.` };
    }
    port = after === '' ? undefined : after.slice(1);
  } else {
    const colon = authority.indexOf(':');
    host = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
    port = colon < 0 ? undefined : authority.slice(colon + 1);
    if (host === '')
      return {
        host,
        problem: 'The address needs a host name, like https://example.com.',
      };
    const labels = host.split('.');
    if (host.length > 253 || !labels.every((label) => LABEL.test(label))) {
      return { host, problem: `${host} is not a valid host name.` };
    }
  }
  if (
    port !== undefined &&
    (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
  ) {
    return {
      host,
      problem: 'The port in the address must be a number from 1 to 65535.',
    };
  }
  return { host };
}

/** Why visitors cannot be sent to this address, or undefined when they can. */
export function redirectProblem(
  url: string,
  keepPath: boolean,
  ownNames: readonly string[],
): string | undefined {
  if (url === '') return 'Enter the address to send visitors to, like https://example.com.';
  if (url.length > MAX_LENGTH) return `The address is longer than ${MAX_LENGTH} characters.`;
  const rest = url.startsWith('https://')
    ? url.slice(8)
    : url.startsWith('http://')
      ? url.slice(7)
      : undefined;
  if (rest === undefined) return 'The address needs to start with https:// or http://.';
  const end = rest.search(/[/?]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? '' : rest.slice(end);
  if (authority.includes('@')) return 'The address cannot carry a user name or password.';
  const { host, problem } = hostProblem(authority);
  if (problem) return problem;
  const bad = [...tail].find((char) => !PATH_CHARACTER.test(char));
  if (bad === '#') return 'The address cannot have a #fragment.';
  if (bad) return `The address cannot contain ${describe(bad)}; write it percent-encoded.`;
  if (keepPath && tail.includes('?')) {
    return 'With the path kept, the address cannot have a query of its own. Turn off keeping the path to send everyone to this exact address.';
  }
  if (ownNames.some((name) => covers(name, host))) {
    return `${host} is one of this site's own names, so visitors would loop back to it forever.`;
  }
  return undefined;
}

const EXAMPLE_PATH = '/pricing?plan=pro';

/** Where a sample request lands, for the editor to show beside the options. */
export function redirectExample(
  from: string,
  to: string,
  keepPath: boolean,
): { from: string; to: string } {
  const source = from.trim().toLowerCase() || 'example.com';
  const destination = to.trim() || 'https://…';
  return {
    from: `${source}${EXAMPLE_PATH}`,
    to: keepPath ? `${destination.replace(/\/+$/, '')}${EXAMPLE_PATH}` : destination,
  };
}

export interface RedirectSuggestion {
  /** The name to redirect to the site's first domain. */
  name: string;
  /** The site serves the name now; taking the suggestion stops that and redirects it instead. */
  move: boolean;
}

/** Second-level labels under which a registrable domain has three labels (example.co.uk). */
const SHORT_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

function isApex(domain: string): boolean {
  const labels = domain.split('.');
  return (
    labels.length === 2 ||
    (labels.length === 3 && SHORT_SECOND_LEVEL.has(labels[1]) && labels[2].length === 2)
  );
}

/**
 * The www counterpart of the site's first domain, when it is not redirected yet: www.example.com
 * for example.com, and example.com for www.example.com. Null for a subdomain or a wildcard.
 */
export function suggestRedirect(
  domains: readonly string[],
  redirectDomains: readonly string[],
): RedirectSuggestion | null {
  const first = (domains[0] ?? '').trim().toLowerCase();
  if (first === '' || first.includes('*') || !first.includes('.')) return null;
  const name = first.startsWith('www.') ? first.slice(4) : isApex(first) ? `www.${first}` : null;
  if (!name || !name.includes('.')) return null;
  const redirected = redirectDomains.map((domain) => domain.trim().toLowerCase());
  if (redirected.includes(name)) return null;
  const served = domains.slice(1).some((domain) => domain.trim().toLowerCase() === name);
  return { name, move: served };
}

/** The draft with the suggestion taken: the name redirected, and no longer served if it was. */
export function applyRedirectSuggestion(
  draft: SiteDraft,
  suggestion: RedirectSuggestion,
): SiteDraft {
  const rows = draft.redirectDomains.filter((row) => row.trim() !== '');
  const domains = suggestion.move
    ? draft.domains.filter(
        (domain, index) => index === 0 || domain.trim().toLowerCase() !== suggestion.name,
      )
    : draft.domains;
  return { ...draft, domains, redirectDomains: [...rows, suggestion.name] };
}
