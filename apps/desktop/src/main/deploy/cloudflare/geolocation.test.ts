import { describe, expect, it } from 'vitest';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import { CloudflareGeolocation } from './geolocation';
import { ALL_GRANTS } from './testing/fakeCloudflare';
import { connectedService, makeService } from './testing/harness';
import { OTHER_ZONE_ID, ZONE_ID } from './testing/recorded';

/**
 * Cloudflare's visitor location for a server's sites (E109 T3b), against the recorded Cloudflare
 * fake: IP Geolocation (the CF-IPCountry header) and the "Add visitor location headers" Managed
 * Transform (city and region), read per site and turned on per zone with this computer's token.
 */

function site(id: string, domains: string[]) {
  return {
    id,
    domains,
    upstream: {
      kind: 'servicePort' as const,
      port: 3000,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: false,
    gzip: true,
    http2: true,
    redirectToHttps: false,
  };
}

function core() {
  const fake = new FakeCore(() => 1_700_000_000_000);
  fake.nginx.saveSite(site('blog', ['blog.example.com']));
  fake.nginx.saveSite(site('shop', ['www.example.com', 'shop.example.com']));
  fake.nginx.saveSite(site('away', ['away.example.org']));
  return fake;
}

async function setup(options: Parameters<typeof connectedService>[0] = {}) {
  const harness = await connectedService({
    token: { grants: { ...ALL_GRANTS, transformRules: 'edit' } },
    zones: [
      { id: ZONE_ID, name: 'example.com' },
      { id: OTHER_ZONE_ID, name: 'elsewhere.net' },
    ],
    ...options,
  });
  const server = core();
  const geolocation = new CloudflareGeolocation({
    cloudflare: harness.service,
    links: { call: (_id, work) => work(server.connect() as unknown as ICoreHub) },
  });
  return { ...harness, server, geolocation };
}

describe('CloudflareGeolocation', () => {
  it('reads both settings for each site on a zone it knows, once per zone', async () => {
    const { geolocation, fake } = await setup();
    fake.zones.get(ZONE_ID)!.settings.ip_geolocation.value = 'on';

    const status = await geolocation.status('srv');

    expect(status.connected).toBe(true);
    expect(status.sites).toEqual([
      {
        siteId: 'away',
        domain: 'away.example.org',
        zoneId: null,
        zoneName: null,
        ipGeolocation: null,
        locationHeaders: null,
      },
      {
        siteId: 'blog',
        domain: 'blog.example.com',
        zoneId: ZONE_ID,
        zoneName: 'example.com',
        ipGeolocation: true,
        locationHeaders: false,
      },
      {
        siteId: 'shop',
        domain: 'www.example.com',
        zoneId: ZONE_ID,
        zoneName: 'example.com',
        ipGeolocation: true,
        locationHeaders: false,
      },
    ]);
    const reads = fake.requests.filter((request) => request.path.startsWith(`/zones/${ZONE_ID}/`));
    expect(reads.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET /zones/${ZONE_ID}/settings/ip_geolocation`,
      `GET /zones/${ZONE_ID}/managed_headers`,
    ]);
  });

  it('turns both on for a zone of the server and reads them back', async () => {
    const { geolocation, fake } = await setup();

    const status = await geolocation.turnOn('srv', ZONE_ID);

    expect(fake.writes().map((request) => [request.method, request.path, request.body])).toEqual([
      ['PATCH', `/zones/${ZONE_ID}/settings/ip_geolocation`, { value: 'on' }],
      [
        'PATCH',
        `/zones/${ZONE_ID}/managed_headers`,
        {
          managed_request_headers: [{ id: 'add_visitor_location_headers', enabled: true }],
          managed_response_headers: [],
        },
      ],
    ]);
    expect(status.sites.find((entry) => entry.siteId === 'blog')).toMatchObject({
      ipGeolocation: true,
      locationHeaders: true,
    });
    // Other Managed Transforms stay as they were.
    expect(
      fake.zones
        .get(ZONE_ID)!
        .managedHeaders.managed_request_headers.find(
          (header) => header.id === 'add_true_client_ip_headers',
        )?.enabled,
    ).toBe(false);
  });

  it('refuses a zone none of the server’s sites is on', async () => {
    const { geolocation, fake } = await setup();

    await expect(geolocation.turnOn('srv', OTHER_ZONE_ID)).rejects.toThrow(
      'None of the websites on this server is on that Cloudflare zone.',
    );
    expect(fake.writes()).toEqual([]);
  });

  it('says what the token is missing when Cloudflare refuses a read', async () => {
    const { geolocation } = await setup({
      token: { grants: { zone: 'read', zoneSettings: 'read' } },
    });

    const status = await geolocation.status('srv');
    const blog = status.sites.find((entry) => entry.siteId === 'blog');
    expect(blog).toMatchObject({ ipGeolocation: false, locationHeaders: null });
    expect(blog?.problem).toMatch(/Transform Rules/);
  });

  it('turns IP Geolocation on even when the token may not touch Managed Transforms', async () => {
    const { geolocation, fake } = await setup({ token: { grants: ALL_GRANTS } });

    await expect(geolocation.turnOn('srv', ZONE_ID)).rejects.toThrow(/Transform Rules/);
    expect(fake.zones.get(ZONE_ID)!.settings.ip_geolocation.value).toBe('on');
  });

  it('says so when no Cloudflare account is connected here', async () => {
    const { service } = makeService();
    const server = core();
    const geolocation = new CloudflareGeolocation({
      cloudflare: service,
      links: { call: (_id, work) => work(server.connect() as unknown as ICoreHub) },
    });

    const status = await geolocation.status('srv');
    expect(status.connected).toBe(false);
    expect(status.sites.map((entry) => entry.zoneId)).toEqual([null, null, null]);
  });

  it('passes on a locked vault rather than calling it not connected', async () => {
    const { geolocation, lock } = await setup();
    lock.value = true;

    await expect(geolocation.status('srv')).rejects.toThrow(/locked/);
  });

  it('says the role cannot list the sites when the core turns the call down', async () => {
    const harness = await connectedService({ zones: [{ id: ZONE_ID, name: 'example.com' }] });
    const refused = new Error("Failed to invoke 'ListSites' because user is unauthorized");
    const geolocation = new CloudflareGeolocation({
      cloudflare: harness.service,
      links: { call: () => Promise.reject(refused) },
    });

    await expect(geolocation.status('srv')).rejects.toThrow(/Your role on this server cannot/);
    await expect(geolocation.turnOn('srv', ZONE_ID)).rejects.toThrow(
      /Your role on this server cannot/,
    );
    expect(harness.fake.writes()).toEqual([]);
  });

  it('leaves IP Geolocation unknown, with the reason, when the token may not read zone settings', async () => {
    const { geolocation } = await setup({
      token: { grants: { zone: 'read', transformRules: 'read' } },
    });

    const status = await geolocation.status('srv');
    const blog = status.sites.find((entry) => entry.siteId === 'blog');
    expect(blog).toMatchObject({ ipGeolocation: null, locationHeaders: false });
    expect(blog?.problem).toMatch(/Zone Settings/);
  });
});
