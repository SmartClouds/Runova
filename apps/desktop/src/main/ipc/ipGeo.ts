import { ipcMain } from 'electron';
import type { IpGeoInfo } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';

const LOOKUP_TIMEOUT_MS = 5000;
/** A machine's public IP rarely moves mid-session, and every window and widget asks for it. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { value: IpGeoInfo; at: number } | null = null;
let inFlight: Promise<IpGeoInfo> | null = null;

/**
 * A fixed answer for e2e runs that set one (the website screenshots), so the real public IP of
 * the machine taking them never shows. Read on every lookup, not at load, so tests can stub it.
 */
function e2eDemoIpGeo(): IpGeoInfo | null {
  const raw = process.env.RUNOVA_E2E === '1' ? process.env.RUNOVA_E2E_IP_GEO : undefined;
  if (!raw) return null;
  const record = JSON.parse(raw) as Partial<IpGeoInfo>;
  return {
    ip: record.ip ?? '',
    country: record.country ?? 'Unknown',
    countryCode: record.countryCode ?? '',
  };
}

// Uses geojs.io's free JSON endpoint (no API key, no rate-limit signup) to
// resolve the machine's public IP and country. Same "no setup required"
// tradeoff as the translate handler; treat failures as recoverable.
async function lookupIpGeo(): Promise<IpGeoInfo> {
  const demo = e2eDemoIpGeo();
  if (demo) return demo;
  // Without a signal a stalled connection (captive portal, dropped packets) leaves
  // the IPC promise pending forever and the dashboard card stuck loading.
  const response = await fetch('https://get.geojs.io/v1/ip/geo.json', {
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`IP lookup failed with status ${response.status}`);
  }

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) {
    throw new Error('Unexpected IP lookup response shape.');
  }

  const record = data as Record<string, unknown>;
  return {
    ip: typeof record.ip === 'string' ? record.ip : '',
    country: typeof record.country === 'string' ? record.country : 'Unknown',
    countryCode: typeof record.country_code === 'string' ? record.country_code : '',
  };
}

/**
 * Serves the cached answer, and collapses concurrent lookups into one request.
 * `force` skips the cache so a manual refresh really asks the network again.
 */
function cachedIpGeo(force: boolean): Promise<IpGeoInfo> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  if (inFlight) return inFlight;
  inFlight = lookupIpGeo()
    .then((value) => {
      cached = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function registerIpGeoHandlers(): void {
  ipcMain.handle(
    IPC.ipGeo.lookup,
    (_event, force?: boolean): Promise<IpGeoInfo> => cachedIpGeo(force === true),
  );
}
