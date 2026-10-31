/**
 * The core domain's name (E44), checked the way the core checks it: one ASCII DNS name (xn-- for an
 * international one), no wildcard, no address. The core checks it again; this only spares a round
 * trip and gives the form its message.
 */

export type CoreDomainNameCheck = { ok: true; value: string } | { ok: false; reason: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function checkCoreDomainName(input: string): CoreDomainNameCheck {
  const value = input.trim().toLowerCase();
  if (value.length === 0) return { ok: false, reason: 'Enter a domain, such as core.example.com.' };
  if (value.startsWith('*.')) {
    return { ok: false, reason: 'The server core answers for one domain, not a wildcard.' };
  }
  if (/^https?:\/\//.test(value) || value.includes('/')) {
    return { ok: false, reason: 'Enter only the domain, without https:// or a path.' };
  }
  if (value.endsWith('.'))
    return { ok: false, reason: 'Write the domain without the trailing dot.' };
  if (/^[0-9.]+$/.test(value) || value.includes(':')) {
    return { ok: false, reason: 'That is an IP address. The core domain has to be a domain name.' };
  }
  if (value.length > 253) return { ok: false, reason: 'A domain is at most 253 characters.' };
  const labels = value.split('.');
  if (labels.length < 2) {
    return { ok: false, reason: 'Use a full domain with a dot, such as core.example.com.' };
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return {
      ok: false,
      reason:
        'A domain has letters, digits and hyphens between its dots (xn-- for international names).',
    };
  }
  return { ok: true, value };
}
