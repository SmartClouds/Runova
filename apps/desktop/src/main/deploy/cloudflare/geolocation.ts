import { cloudflareErrorCode, cloudflareErrorMessage } from '../../../shared/cloudflareErrors';
import type { CloudflareZone } from '../../../shared/cloudflareTypes';
import type { SiteInfo } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { TrafficGeolocationStatus, TrafficGeoSite } from '../../../shared/deployTrafficTypes';
import { callCore } from '../coreCalls';
import type { CoreLinks } from '../live/coreLinks';
import { zoneOf } from './serverOps';
import type { CloudflareService } from './service';

/**
 * Cloudflare's visitor location for a server's websites (E109 T3b). The traffic report places a
 * visitor by Cloudflare's `CF-IPCountry` header (IP Geolocation, a zone setting) and, when the
 * zone's "Add visitor location headers" Managed Transform is on, by city and region too. Both are
 * read and turned on from this computer with the account token it already keeps; the token never
 * goes to the server. Only zones that hold one of the server's sites can be changed here.
 */

const IP_GEOLOCATION = 'ip_geolocation';
const LOCATION_HEADERS = 'add_visitor_location_headers';
const NOT_THIS_SERVER = 'None of the websites on this server is on that Cloudflare zone.';

export interface CloudflareGeolocationDeps {
  cloudflare: Pick<CloudflareService, 'useApi' | 'allZones'>;
  links: Pick<CoreLinks, 'call'>;
  roles?: (serverId: string) => string[] | null;
}

interface ZoneReading {
  ipGeolocation: boolean | null;
  locationHeaders: boolean | null;
  problem?: string;
}

export class CloudflareGeolocation {
  constructor(private readonly deps: CloudflareGeolocationDeps) {}

  async status(serverId: string): Promise<TrafficGeolocationStatus> {
    const sites = await callCore(
      { links: this.deps.links, roles: this.deps.roles ?? (() => null) },
      serverId,
      (hub) => hub.listSites(),
    );
    let zones: CloudflareZone[];
    try {
      zones = await this.deps.cloudflare.allZones();
    } catch (error) {
      if (cloudflareErrorCode(error) !== 'no-token') throw error;
      return { connected: false, sites: sites.map((site) => placed(site, [])) };
    }
    const entries = [...sites]
      .sort((a, b) => a.settings.id.localeCompare(b.settings.id))
      .map((site) => placed(site, zones));
    const readings = new Map<string, ZoneReading>();
    for (const entry of entries) {
      if (!entry.zoneId || readings.has(entry.zoneId)) continue;
      const zone = zones.find((candidate) => candidate.id === entry.zoneId) as CloudflareZone;
      readings.set(entry.zoneId, await this.read(zone));
    }
    return {
      connected: true,
      sites: entries.map((entry) => {
        const reading = entry.zoneId ? readings.get(entry.zoneId) : undefined;
        return reading ? { ...entry, ...reading } : entry;
      }),
    };
  }

  /** Turns on IP Geolocation and the visitor location headers for one zone of the server. */
  async turnOn(serverId: string, zoneId: string): Promise<TrafficGeolocationStatus> {
    const zones = await this.deps.cloudflare.allZones();
    const sites = await callCore(
      { links: this.deps.links, roles: this.deps.roles ?? (() => null) },
      serverId,
      (hub) => hub.listSites(),
    );
    const zone = zones.find((candidate) => candidate.id === zoneId);
    const ours = sites.some((site) => placed(site, zones).zoneId === zoneId);
    if (!zone || !ours) throw new Error(NOT_THIS_SERVER);
    await this.deps.cloudflare.useApi(zone.accountId, 'zoneSettings', (api) =>
      api.zones.settings.edit(IP_GEOLOCATION, { zone_id: zoneId, value: 'on' }),
    );
    await this.deps.cloudflare.useApi(zone.accountId, 'transformRules', (api) =>
      api.managedTransforms.edit({
        zone_id: zoneId,
        managed_request_headers: [{ id: LOCATION_HEADERS, enabled: true }],
        managed_response_headers: [],
      }),
    );
    return this.status(serverId);
  }

  /** Both settings of a zone; what Cloudflare would not say stays unknown, with the reason. */
  private async read(zone: CloudflareZone): Promise<ZoneReading> {
    const problems: string[] = [];
    let ipGeolocation: boolean | null = null;
    let locationHeaders: boolean | null = null;
    try {
      const setting = (await this.deps.cloudflare.useApi(zone.accountId, 'zoneSettings', (api) =>
        api.zones.settings.get(IP_GEOLOCATION, { zone_id: zone.id }),
      )) as { value?: unknown };
      ipGeolocation = setting.value === 'on';
    } catch (error) {
      problems.push(cloudflareErrorMessage(error));
    }
    try {
      const transforms = await this.deps.cloudflare.useApi(
        zone.accountId,
        'transformRules',
        (api) => api.managedTransforms.list({ zone_id: zone.id }),
      );
      locationHeaders =
        transforms.managed_request_headers.find((header) => header.id === LOCATION_HEADERS)
          ?.enabled ?? false;
    } catch (error) {
      problems.push(cloudflareErrorMessage(error));
    }
    return problems.length > 0
      ? { ipGeolocation, locationHeaders, problem: problems.join(' ') }
      : { ipGeolocation, locationHeaders };
  }
}

/** A site with the first of its domains that is on a known zone, or its first domain. */
function placed(site: SiteInfo, zones: CloudflareZone[]): TrafficGeoSite {
  const domains = site.settings.domains;
  for (const domain of domains) {
    const zone = zoneOf(domain, zones);
    if (zone) {
      return {
        siteId: site.settings.id,
        domain,
        zoneId: zone.id,
        zoneName: zone.name,
        ipGeolocation: null,
        locationHeaders: null,
      };
    }
  }
  return {
    siteId: site.settings.id,
    domain: domains[0] ?? site.settings.id,
    zoneId: null,
    zoneName: null,
    ipGeolocation: null,
    locationHeaders: null,
  };
}
