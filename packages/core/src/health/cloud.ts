import { HEALTH_INTERVAL_PRESETS } from './interval.js';
import type { HealthAuthMode } from './types.js';

/**
 * Online monitors (E56): what an address must be for Runova Cloud to check it, and what the
 * monitor dialog offers. The nodes check from the internet and refuse private addresses, and the
 * server checks the same before it takes a monitor; this says so in the dialog first.
 */

const ON_THIS_COMPUTER =
  'This address is on this computer. Runova Cloud checks from the internet, so it can only check public addresses.';
const PRIVATE =
  'This address is on a private network. Runova Cloud checks from the internet, so give a public address.';
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

function ipv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

/** Null for a public IPv4 address, otherwise which kind of private one it is. */
function ipv4Problem([a, b]: number[]): string | null {
  if (a === 127 || a === 0) return ON_THIS_COMPUTER;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return PRIVATE;
  if (a === 100 && b >= 64 && b <= 127) return PRIVATE;
  if (a === 169 && b === 254) return PRIVATE;
  if (a >= 224) return PRIVATE;
  return null;
}

function ipv6Problem(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower === '::1' || lower === '::') return ON_THIS_COMPUTER;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    const bytes = ipv4(mapped[1]);
    return bytes ? ipv4Problem(bytes) : PRIVATE;
  }
  // The URL parser writes a mapped address as hex: ::ffff:c0a8:102.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return ipv4Problem([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower) || /^fe[89ab][0-9a-f]?:/.test(lower)) return PRIVATE;
  if (lower.startsWith('ff')) return PRIVATE;
  return null;
}

/** Null when Runova Cloud may check the address, otherwise why not, in words for the dialog. */
export function cloudUrlProblem(url: string, allowInsecure: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'Give the full address, such as https://api.example.com/health.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'The address must start with http or https.';
  }
  if (parsed.protocol === 'http:' && !allowInsecure) {
    return 'Runova Cloud checks https addresses. Allow plain http for this monitor to check it anyway.';
  }
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return ON_THIS_COMPUTER;
  if (host.startsWith('[') && host.endsWith(']')) return ipv6Problem(host.slice(1, -1));
  const bytes = ipv4(host);
  if (bytes) return ipv4Problem(bytes);
  if (!host.includes('.') || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return PRIVATE;
  }
  return null;
}

/** The interval presets an account type allows, starting at its floor. */
export function cloudIntervalChoices(floorSec: number): number[] {
  const allowed = HEALTH_INTERVAL_PRESETS.filter((seconds) => seconds >= floorSec);
  return allowed[0] === floorSec ? [...allowed] : [floorSec, ...allowed];
}

/** What the server is given as the monitor's key: the bearer key, or user:password for basic. */
export function cloudSecretFor(
  authMode: HealthAuthMode,
  basicUser: string | null,
  secret: string,
): string {
  return authMode === 'basic' ? `${basicUser ?? ''}:${secret}` : secret;
}
