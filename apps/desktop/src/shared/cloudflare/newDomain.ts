import { normalizeHostname } from './dns';
import { ipVersion } from './ip';

/**
 * What the user typed into "Add a domain", made into the name Cloudflare expects. People paste a
 * whole web address as often as they type a domain, so the scheme, port and path are dropped
 * rather than refused. The renderer checks as the user types and the main process checks again.
 */

export type NewDomainCheck =
  | {
      ok: true;
      name: string;
      /** The main domain, when the name looks like its www subdomain. */
      suggestion: string | null;
    }
  | { ok: false; problem: string };

const EMPTY = 'Type the domain you want to add, like example.com.';
const IP = 'That is an IP address. Type a domain name instead, like example.com.';
const NOT_A_DOMAIN = 'That is not a domain name. Check it for typos.';

function hostOf(text: string): string {
  const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return withoutScheme.split(/[/?#]/, 1)[0] ?? '';
}

export function checkNewDomain(text: string): NewDomainCheck {
  let host = hostOf(text.trim());
  if (ipVersion(host) !== null) return { ok: false, problem: IP };
  host = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  if (ipVersion(host) !== null) return { ok: false, problem: IP };
  if (host === '') return { ok: false, problem: EMPTY };
  if (host.startsWith('*')) return { ok: false, problem: 'Type the domain itself, without the *.' };
  // Record names may hold an underscore, but a registered domain never does.
  const name = host.includes('_') ? null : normalizeHostname(host);
  if (!name) return { ok: false, problem: NOT_A_DOMAIN };
  const labels = name.split('.');
  if (labels.length < 2) return { ok: false, problem: 'Add the ending too, like example.com.' };
  const suggestion = labels.length > 2 && labels[0] === 'www' ? labels.slice(1).join('.') : null;
  return { ok: true, name, suggestion };
}
