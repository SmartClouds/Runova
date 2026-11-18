import { describe, expect, it } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { FakeCore } from '../../../shared/deploy/testing/fakeCore';
import { DeployTraffic } from './service';

/**
 * Traffic statistics and attacks on a server (E109, E110) through the fake core: reading, saving
 * with the form's checks first, the step-ups for deleting statistics and auto-block, blocking, and
 * a core from before this feature turned into a sentence with the way out.
 */

const NOW = Date.UTC(2026, 10, 18, 14, 30);
const DAY = 86_400_000;

function setup(roles = ['owner']) {
  const core = new FakeCore(() => NOW);
  core.roles = roles;
  core.nginx.saveSite({
    id: 'blog',
    domains: ['blog.example.com'],
    upstream: { kind: 'servicePort', port: 3000, verifyCertificate: true, sendUpstreamHost: false },
    websocket: false,
    gzip: true,
    http2: true,
    redirectToHttps: false,
  });
  const traffic = new DeployTraffic({
    links: { call: (_id, work) => work(core.connect() as unknown as ICoreHub) },
    roles: () => roles,
  });
  return { core, traffic };
}

describe('DeployTraffic', () => {
  it('reads the status and a report for one site', async () => {
    const { traffic } = setup(['viewer']);

    const status = await traffic.status('srv');
    expect(status.sites.map((site) => site.siteId)).toEqual(['blog']);

    const report = await traffic.report({
      serverId: 'srv',
      siteId: 'blog',
      fromUnixMs: NOW - 7 * DAY,
      toUnixMs: NOW,
      granularity: 'day',
      compare: true,
    });
    expect(report.siteId).toBe('blog');
    expect(report.series).toHaveLength(8);
    expect(report.previous).toBeDefined();
  });

  it('pages a dimension', async () => {
    const { traffic } = setup(['viewer']);

    const page = await traffic.dimension({
      serverId: 'srv',
      fromUnixMs: NOW - 7 * DAY,
      toUnixMs: NOW,
      dimension: 'page',
      offset: 10,
      limit: 5,
      search: 'post',
    });
    expect(page.items).toHaveLength(5);
    expect(page.items.every((item) => item.value.includes('post'))).toBe(true);
  });

  it('checks the settings before asking the core, and saves good ones', async () => {
    const { core, traffic } = setup(['admin']);
    const settings = (await traffic.status('srv')).settings;

    const refused = await traffic.saveSettings({
      serverId: 'srv',
      settings: { ...settings, dailyRetentionDays: 5 },
    });
    expect(refused).toEqual({
      problems: ['Keep daily figures for 30 to 1825 days.'],
      status: null,
    });
    expect(core.traffic.settings.dailyRetentionDays).toBe(730);

    const saved = await traffic.saveSettings({
      serverId: 'srv',
      settings: { ...settings, enabled: true, readExistingLogs: true },
    });
    expect(saved.problems).toEqual([]);
    expect(saved.status?.settings.enabled).toBe(true);
  });

  it('asks a Viewer who tries to change settings for nothing, and says the role cannot', async () => {
    const { traffic } = setup(['viewer']);
    const settings = (await traffic.status('srv')).settings;

    const error = await traffic
      .saveSettings({ serverId: 'srv', settings: { ...settings, enabled: true } })
      .catch((caught: unknown) => caught);
    expect(coreErrorCode(error)).toBe('forbidden');
  });

  it('deletes statistics only after a step-up, which it makes when handed the password', async () => {
    const { core, traffic } = setup(['admin']);

    const error = await traffic
      .deleteData({ serverId: 'srv', siteId: null })
      .catch((caught: unknown) => caught);
    expect(coreErrorCode(error)).toBe('stepUpRequired');
    expect(core.traffic.deleted).toEqual([]);

    await traffic.deleteData({ serverId: 'srv', siteId: 'blog', password: core.password });
    expect(core.traffic.deleted).toEqual(['blog']);
    await traffic.deleteData({ serverId: 'srv', siteId: null });
    expect(core.traffic.deleted).toEqual(['blog', '*']);
  });

  it('saves detection settings for an Admin, checked first', async () => {
    const { traffic } = setup(['admin']);
    const attacks = (await traffic.status('srv')).attacks;

    expect(
      (
        await traffic.saveAttackSettings({
          serverId: 'srv',
          settings: { ...attacks, allowlist: ['not an address'] },
        })
      ).problems,
    ).toEqual([
      'not an address: write an address such as 203.0.113.7 or a range such as 10.0.0.0/8.',
    ]);

    const saved = await traffic.saveAttackSettings({
      serverId: 'srv',
      settings: { ...attacks, allowlist: ['10.0.0.0/8'] },
    });
    expect(saved.status?.attacks.allowlist).toEqual(['10.0.0.0/8']);
  });

  it('lets only an Owner with a step-up turn auto-block on', async () => {
    const admin = setup(['admin']);
    const settings = { enabled: true, kinds: ['scan' as const], minutes: 60, maxBlocked: 100 };
    const refused = await admin.traffic
      .saveAutoBlock({ serverId: 'srv', settings, password: admin.core.password })
      .catch((caught: unknown) => caught);
    expect(coreErrorCode(refused)).toBe('forbidden');

    const owner = setup(['owner']);
    const asked = await owner.traffic
      .saveAutoBlock({ serverId: 'srv', settings })
      .catch((caught: unknown) => caught);
    expect(coreErrorCode(asked)).toBe('stepUpRequired');

    const saved = await owner.traffic.saveAutoBlock({
      serverId: 'srv',
      settings,
      password: owner.core.password,
    });
    expect(saved.status?.autoBlock).toEqual(settings);
  });

  it('lists attacks, blocks an address and lets it back', async () => {
    const { traffic } = setup(['admin']);

    const summary = await traffic.attacks({ serverId: 'srv', siteId: 'blog', limit: 50 });
    expect(summary.events.map((event) => event.kind)).toEqual(['scan', 'injection']);

    const blocked = await traffic.block({
      serverId: 'srv',
      network: '198.51.100.23',
      reason: 'Scan on blog',
      siteId: 'blog',
    });
    expect(blocked.blocked?.network).toBe('198.51.100.23');
    expect((await traffic.blocked('srv')).map((block) => block.network)).toEqual(['198.51.100.23']);
    expect((await traffic.attacks({ serverId: 'srv', limit: 50 })).blocked).toBe(1);

    await traffic.unblock({ serverId: 'srv', blockId: blocked.blocked?.id ?? 0 });
    expect(await traffic.blocked('srv')).toEqual([]);
  });

  it('refuses an address that is not one without asking the core', async () => {
    const { core, traffic } = setup(['admin']);

    const result = await traffic.block({ serverId: 'srv', network: 'example.com' });
    expect(result.problems[0]).toMatch(/not an address/);
    expect(core.traffic.blocks).toEqual([]);
  });

  it('turns a core from before this feature into a sentence with the way out', async () => {
    const { core, traffic } = setup();
    core.trafficMissing = true;

    await expect(traffic.status('srv')).rejects.toThrow(
      'This server runs an older core without traffic statistics. Update the core from the Overview, then try again.',
    );
  });
});
