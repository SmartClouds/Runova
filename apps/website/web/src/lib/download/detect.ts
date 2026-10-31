/**
 * Which desktop system a visitor is on, from User-Agent Client Hints first and the user agent
 * string second. Anything that is not Windows, macOS or Linux on a desktop (phones, tablets,
 * ChromeOS, bots) is unknown, so the download page never offers it a wrong installer.
 */

export type DesktopOs = 'windows' | 'macos' | 'linux';
export type DesktopArch = 'x64' | 'arm64';

export interface VisitorSystem {
  os: DesktopOs | null;
  arch: DesktopArch | null;
}

/** The raw signals: the User-Agent header and the Sec-CH-UA-* hint values, unquoted. */
export interface SystemSignals {
  userAgent?: string | null;
  platform?: string | null;
  arch?: string | null;
  bitness?: string | null;
}

/** The client hints the page asks for (Accept-CH) and varies on. */
export const CLIENT_HINTS = ['Sec-CH-UA-Platform', 'Sec-CH-UA-Arch', 'Sec-CH-UA-Bitness'];

const HINT_PLATFORMS: Record<string, DesktopOs | null> = {
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
  android: null,
  ios: null,
  'chrome os': null,
  chromeos: null,
};

function osFromHint(platform: string | null | undefined): DesktopOs | null | undefined {
  const key = platform?.trim().toLowerCase();
  if (!key || !(key in HINT_PLATFORMS)) return undefined;
  return HINT_PLATFORMS[key];
}

function archFromHint(
  arch: string | null | undefined,
  bitness: string | null | undefined,
): DesktopArch | null | undefined {
  const name = arch?.trim().toLowerCase();
  if (!name) return undefined;
  if (bitness?.trim() && bitness.trim() !== '64') return null;
  if (name === 'x86') return 'x64';
  if (name === 'arm') return 'arm64';
  return null;
}

function osFromUserAgent(ua: string): DesktopOs | null {
  // Phones and tablets first: iOS says "like Mac OS X" and Android says "Linux".
  if (/android|iphone|ipad|ipod|mobile/i.test(ua)) return null;
  if (/\bCrOS\b/.test(ua)) return null;
  if (/Windows NT/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return null;
}

function archFromUserAgent(ua: string, os: DesktopOs): DesktopArch | null {
  // Every Mac browser reports "Intel Mac OS X", Apple silicon included.
  if (os === 'macos') return null;
  if (/aarch64|arm64/i.test(ua)) return 'arm64';
  if (/x86_64|x64|amd64|win64|wow64/i.test(ua)) return 'x64';
  return null;
}

export function detectSystem(signals: SystemSignals): VisitorSystem {
  const ua = signals.userAgent ?? '';
  const hintedOs = osFromHint(signals.platform);
  const os = hintedOs === undefined ? osFromUserAgent(ua) : hintedOs;
  if (!os) return { os: null, arch: null };
  const hintedArch = archFromHint(signals.arch, signals.bitness);
  const arch = hintedArch === undefined ? archFromUserAgent(ua, os) : hintedArch;
  return { os, arch };
}

/** A structured header string such as `"macOS"`, without its quotes. */
function unquote(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^".*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

export function signalsFromHeaders(headers: Headers): SystemSignals {
  return {
    userAgent: headers.get('user-agent'),
    platform: unquote(headers.get('sec-ch-ua-platform')),
    arch: unquote(headers.get('sec-ch-ua-arch')),
    bitness: unquote(headers.get('sec-ch-ua-bitness')),
  };
}
