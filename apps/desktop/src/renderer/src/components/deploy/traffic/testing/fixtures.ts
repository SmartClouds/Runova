import { FakeTraffic } from '@shared/deploy/testing/fakeTraffic';
import type {
  DeployAttackListInput,
  DeployAttackSettingsInput,
  DeployAutoBlockInput,
  DeployBlockInput,
  DeployTrafficDeleteInput,
  DeployTrafficDimensionInput,
  DeployTrafficReportInput,
  DeployTrafficSettingsInput,
  DeployUnblockInput,
  TrafficGeolocationStatus,
} from '@shared/deployTrafficTypes';
import { vi } from 'vitest';
import { signedIn } from '../../security/testing/fixtures';

/**
 * The Traffic section's tests talk to the pretend core's traffic side (E109, E110) through the
 * bridge, so the reports, settings and blocks they see behave like a core's: totals that add up,
 * settings checked with the core's rules, blocks that show up in the attack list.
 */

export { SERVER, signedIn } from '../../security/testing/fixtures';

export const OLDER_CORE =
  'This server runs an older core without traffic statistics. Update the core from the Overview, then try again.';

export const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353';

export function trafficFake(options: { enabled?: boolean; empty?: boolean } = {}): FakeTraffic {
  const fake = new FakeTraffic({
    now: () => Date.now(),
    userName: () => 'maria',
    sites: () => [
      { siteId: 'blog', domains: ['blog.example.com'] },
      { siteId: 'shop', domains: ['shop.example.com'] },
    ],
  });
  fake.settings.enabled = options.enabled ?? true;
  fake.empty = options.empty ?? false;
  return fake;
}

export const GEOLOCATION: TrafficGeolocationStatus = {
  connected: true,
  sites: [
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
      domain: 'shop.example.org',
      zoneId: null,
      zoneName: null,
      ipGeolocation: null,
      locationHeaders: null,
    },
  ],
};

/** Bridge answers that route every traffic call to `fake`, as `vi.fn`s a test can look at. */
export function trafficBridge(fake: FakeTraffic, roles: string[] = ['owner']) {
  return {
    'deploy.access': async () => signedIn(roles),
    'deployTraffic.status': vi.fn(async () => fake.status()),
    'deployTraffic.report': vi.fn(async ({ serverId: _, ...request }: DeployTrafficReportInput) =>
      fake.report(request),
    ),
    'deployTraffic.dimension': vi.fn(
      async ({ serverId: _, ...request }: DeployTrafficDimensionInput) => fake.dimension(request),
    ),
    'deployTraffic.saveSettings': vi.fn(async ({ settings }: DeployTrafficSettingsInput) => {
      const result = fake.saveSettings(settings);
      return { problems: result.problems, status: result.status ?? null };
    }),
    'deployTraffic.deleteData': vi.fn(async ({ siteId }: DeployTrafficDeleteInput) =>
      fake.deleteData(siteId),
    ),
    'deployTraffic.attacks': vi.fn(async ({ serverId: _, ...query }: DeployAttackListInput) =>
      fake.attacks(query),
    ),
    'deployTraffic.saveAttackSettings': vi.fn(async ({ settings }: DeployAttackSettingsInput) => {
      const result = fake.saveAttackSettings(settings);
      return { problems: result.problems, status: result.status ?? null };
    }),
    'deployTraffic.saveAutoBlock': vi.fn(async ({ settings }: DeployAutoBlockInput) => {
      const result = fake.saveAutoBlock(settings);
      return { problems: result.problems, status: result.status ?? null };
    }),
    'deployTraffic.blocked': vi.fn(async () => fake.blocked()),
    'deployTraffic.block': vi.fn(async ({ serverId: _, ...request }: DeployBlockInput) =>
      fake.block(request),
    ),
    'deployTraffic.unblock': vi.fn(async ({ blockId }: DeployUnblockInput) =>
      fake.unblock(blockId),
    ),
    'deployTraffic.watchLive': vi.fn(async () => 'live-1'),
    'deployTraffic.unwatchLive': vi.fn(async () => true),
    'deployTraffic.geolocation': vi.fn(async () => GEOLOCATION),
    'deployTraffic.turnOnGeolocation': vi.fn(async () => ({
      connected: true,
      sites: GEOLOCATION.sites.map((site) =>
        site.zoneId ? { ...site, ipGeolocation: true, locationHeaders: true } : site,
      ),
    })),
  };
}
