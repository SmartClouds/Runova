import type { CloudflareRuleSpec } from '../cloudflareTypes';
import { canonicalIp, checkCidr } from './ip';
import { MAX_RULE_ADDRESSES } from './rules';

/**
 * The words around an IP limit: what it covers, who it lets in, and the addresses typed or pasted
 * into it. The rule itself is built and read back in rules.ts, with the other custom rules.
 */

export { ipLockDescription, parseIpLock } from './rules';

export type IpLockSpec = Extract<CloudflareRuleSpec, { kind: 'ip-lock' }>;

export const MAX_IP_LOCK_ADDRESSES = MAX_RULE_ADDRESSES;

export type AddressEntry =
  | { kind: 'address'; value: string }
  | { kind: 'invalid'; value: string; reason: string };

/** "app.example.com/admin and below", or "every name in example.com". */
export function ipLockTarget(spec: IpLockSpec, zoneName: string): string {
  const path =
    spec.path === null ? '' : `${spec.path}${spec.match === 'prefix' ? ' and below' : ''}`;
  if (spec.hostname === null) {
    const everywhere = `every name in ${zoneName}`;
    return path ? `${path}, on ${everywhere}` : everywhere;
  }
  return `${spec.hostname.toLowerCase()}${path}`;
}

/** The dialog's live sentence on who gets in and what everyone else sees. */
export function ipLockPreview(spec: IpLockSpec, zoneName: string): string {
  const target = ipLockTarget(spec, zoneName);
  const [first, second] = spec.ips;
  if (first === undefined) return `Add at least one address to say who can open ${target}.`;
  let who: string;
  if (spec.ips.length === 1) who = first;
  else if (spec.ips.length === 2) who = `${first} and ${second}`;
  else who = `${first} and ${spec.ips.length - 1} more addresses`;
  return `Only ${who} can open ${target}. Everyone else gets Cloudflare's block page.`;
}

/**
 * Typed or pasted text split on spaces, commas, semicolons and new lines into addresses and
 * ranges, each in the spelling Cloudflare uses. Repeats are dropped; what cannot be used says why.
 */
export function parseAddresses(text: string): AddressEntry[] {
  const seen = new Set<string>();
  const entries: AddressEntry[] = [];
  for (const piece of text.split(/[\s,;]+/)) {
    if (!piece) continue;
    let entry: AddressEntry;
    const ip = canonicalIp(piece);
    if (ip) {
      entry = { kind: 'address', value: ip };
    } else if (piece.includes('/')) {
      const range = checkCidr(piece);
      entry = range.ok
        ? { kind: 'address', value: range.network }
        : { kind: 'invalid', value: piece, reason: range.problem };
    } else {
      entry = {
        kind: 'invalid',
        value: piece,
        reason: 'This is not an IP address or a range like 203.0.113.0/24.',
      };
    }
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    entries.push(entry);
  }
  return entries;
}
