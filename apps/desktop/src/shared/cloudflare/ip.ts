/**
 * IP addresses and ranges, checked by hand because this runs in the renderer as well as in the
 * main process (no node:net there). IPv6 is written back the way RFC 5952 asks, which is how
 * Cloudflare returns it, so an address typed one way still matches a record stored another way.
 */

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEXTET = /^[0-9a-fA-F]{1,4}$/;
const PREFIX = /^(0|[1-9]\d{0,2})$/;

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => OCTET.test(part))) return null;
  return parts.map(Number);
}

function parseGroups(text: string): number[] | null {
  if (text === '') return [];
  const groups = text.split(':');
  if (!groups.every((group) => HEXTET.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function parseIpv6(text: string): number[] | null {
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon >= 0 && text.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = text.slice(0, lastColon + 1);
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!left || !right) return null;
  const count = left.length + right.length + tail.length;
  if (halves.length === 1) return count === 8 ? [...left, ...tail] : null;
  // "::" stands for at least one group of zeros.
  if (count > 7) return null;
  return [...left, ...new Array<number>(8 - count).fill(0), ...right, ...tail];
}

function formatIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

export function ipVersion(text: string): 4 | 6 | null {
  if (parseIpv4(text)) return 4;
  if (parseIpv6(text)) return 6;
  return null;
}

/** The address in the one spelling Cloudflare uses, or null when it is not an address. */
export function canonicalIp(text: string): string | null {
  const v4 = parseIpv4(text);
  if (v4) return v4.join('.');
  const v6 = parseIpv6(text);
  return v6 ? formatIpv6(v6) : null;
}

function isPublicIpv4([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  return !(a === 192 && b === 168);
}

/**
 * Whether the internet can reach the address: not private, loopback, link-local, shared (CGNAT),
 * multicast or reserved. Documentation ranges pass, since nothing real ever uses them.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPublicIpv4(v4);
  const v6 = parseIpv6(ip);
  if (!v6) return false;
  const [first] = v6;
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return isPublicIpv4([v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff]);
  }
  if (v6.slice(0, 7).every((group) => group === 0) && v6[7] <= 1) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  return (first & 0xff00) !== 0xff00;
}

export type CidrCheck =
  | { ok: true; version: 4 | 6; prefix: number; network: string }
  | { ok: false; problem: string };

/** Clears the bits past `prefix`, in chunks of `bits` (8 for IPv4 octets, 16 for IPv6 groups). */
function mask(chunks: number[], bits: number, prefix: number): number[] {
  return chunks.map((value, index) => {
    const keep = Math.max(0, Math.min(bits, prefix - index * bits));
    return keep === 0 ? 0 : value & ((0xffff << (bits - keep)) & ((1 << bits) - 1));
  });
}

/** A range in CIDR notation, which has to start at its own first address. */
export function checkCidr(text: string): CidrCheck {
  const notRange = { ok: false as const, problem: `${text} is not a range like 203.0.113.0/24.` };
  const slash = text.indexOf('/');
  if (slash < 0) return notRange;
  const address = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  const v4 = parseIpv4(address);
  const v6 = v4 ? null : parseIpv6(address);
  if ((!v4 && !v6) || !PREFIX.test(prefixText)) return notRange;
  const prefix = Number(prefixText);
  const version = v4 ? 4 : 6;
  if (prefix > (v4 ? 32 : 128)) {
    return { ok: false, problem: `IPv${version} ranges go up to /${v4 ? 32 : 128}.` };
  }
  const start = v4 ? mask(v4, 8, prefix).join('.') : formatIpv6(mask(v6 ?? [], 16, prefix));
  const written = v4 ? v4.join('.') : formatIpv6(v6 ?? []);
  const network = `${start}/${prefix}`;
  if (start !== written) {
    return { ok: false, problem: `${text} is not the start of its range. Use ${network}.` };
  }
  return { ok: true, version, prefix, network };
}

/** Whether an address is one of the list, or inside one of its ranges. IPv4 never matches IPv6. */
export function addressInList(ip: string, list: readonly string[]): boolean {
  const v4 = parseIpv4(ip);
  const chunks = v4 ?? parseIpv6(ip);
  if (!chunks) return false;
  const bits = v4 ? 8 : 16;
  return list.some((entry) => {
    const slash = entry.indexOf('/');
    const address = slash < 0 ? entry : entry.slice(0, slash);
    const prefix = slash < 0 ? (v4 ? 32 : 128) : Number(entry.slice(slash + 1));
    const other = v4 ? parseIpv4(address) : parseIpv4(address) ? null : parseIpv6(address);
    if (!other || !Number.isInteger(prefix) || prefix < 0 || prefix > chunks.length * bits) {
      return false;
    }
    const a = mask(chunks, bits, prefix);
    const b = mask(other, bits, prefix);
    return a.every((value, index) => value === b[index]);
  });
}
