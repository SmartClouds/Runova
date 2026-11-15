import { describe, expect, it } from 'vitest';
import { cloudflareErrorPermission } from '../../../shared/cloudflareErrors';
import { ALL_GRANTS } from './testing/fakeCloudflare';
import { connectedService, makeService, TOKEN } from './testing/harness';
import {
  ACCESS_RULE_ID,
  accessRule,
  customRuleset,
  dnsRecord,
  RULE_ID,
  RULESET_ID,
  ZONE_ID,
} from './testing/recorded';

/**
 * Security rules (T4) and "point domain to this server" (T5, AC2) through the service, against the
 * fake Cloudflare API.
 */

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to fail');
}

describe('WAF custom rules (T4)', () => {
  it('reads a zone with no custom rules yet as an empty list', async () => {
    const { service } = await connectedService();
    expect(await service.listCustomRules(ZONE_ID)).toEqual([]);
  });

  it('lists the rules of the custom phase', async () => {
    const { service } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', ruleset: customRuleset }],
    });
    expect(await service.listCustomRules(ZONE_ID)).toEqual([
      {
        id: RULE_ID,
        description: 'Block Tor exit nodes',
        expression: '(ip.src.country in {"T1"})',
        action: 'block',
        enabled: true,
        lastUpdated: '2024-06-01T12:00:00Z',
      },
    ]);
  });

  it('creates the entry point with the first rule when the zone has none', async () => {
    const { service, fake } = await connectedService();

    const rules = await service.createCustomRule(ZONE_ID, {
      description: 'Block CN',
      spec: { kind: 'block-countries', countries: ['CN'] },
    });

    expect(fake.writes()).toHaveLength(1);
    expect(fake.writes()[0]).toMatchObject({
      method: 'POST',
      path: `/zones/${ZONE_ID}/rulesets`,
      body: {
        kind: 'zone',
        phase: 'http_request_firewall_custom',
        name: 'default',
        rules: [
          {
            description: 'Block CN',
            expression: '(ip.src.country in {"CN"})',
            action: 'block',
            enabled: true,
          },
        ],
      },
    });
    expect(rules.map((rule) => rule.description)).toEqual(['Block CN']);
  });

  it('adds to the existing rules, and puts an allow rule first', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', ruleset: customRuleset }],
    });

    const rules = await service.createCustomRule(ZONE_ID, {
      description: 'Allow the office',
      spec: { kind: 'allow-ips', ips: ['203.0.113.0/24'] },
    });

    expect(fake.writes()[0]).toMatchObject({
      method: 'POST',
      path: `/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules`,
      body: {
        action: 'skip',
        action_parameters: { ruleset: 'current' },
        expression: '(ip.src in {203.0.113.0/24})',
        position: { index: 1 },
      },
    });
    expect(rules.map((rule) => rule.description)).toEqual([
      'Allow the office',
      'Block Tor exit nodes',
    ]);
  });

  it('turns a rule off and on with its whole definition, and deletes it', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', ruleset: customRuleset }],
    });

    const off = await service.setCustomRuleEnabled(ZONE_ID, RULE_ID, false);
    expect(off[0].enabled).toBe(false);
    expect(fake.writes()[0]).toMatchObject({
      method: 'PATCH',
      path: `/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/${RULE_ID}`,
      body: { action: 'block', expression: '(ip.src.country in {"T1"})', enabled: false },
    });

    expect(await service.deleteCustomRule(ZONE_ID, RULE_ID)).toEqual([]);
  });

  it('says a rule is gone when it is not in the zone any more', async () => {
    const { service } = await connectedService();
    await expect(service.setCustomRuleEnabled(ZONE_ID, RULE_ID, false)).rejects.toThrow(
      'That rule is not in this zone any more. Refresh the list.',
    );
    await expect(service.deleteCustomRule(ZONE_ID, RULE_ID)).rejects.toThrow(/not in this zone/);
  });

  it('refuses a rule the builder cannot write, before calling Cloudflare', async () => {
    const { service, fake } = await connectedService();
    await expect(
      service.createCustomRule(ZONE_ID, {
        description: 'x',
        spec: { kind: 'block-countries', countries: [] },
      }),
    ).rejects.toThrow(/at least one country/);
    expect(fake.requests).toEqual([]);
  });

  it('names Zone WAF when the token cannot change rules', async () => {
    const { service } = await connectedService({
      token: { grants: { ...ALL_GRANTS, waf: 'read' } },
    });
    const error = await rejection(
      service.createCustomRule(ZONE_ID, {
        description: 'Block CN',
        spec: { kind: 'block-countries', countries: ['CN'] },
      }),
    );
    expect(cloudflareErrorPermission(error)).toBe('waf');
  });
});

describe('IP limits (E97)', () => {
  const ACME = 'not starts_with(http.request.uri.path, "/.well-known/acme-challenge/")';
  const lock = {
    kind: 'ip-lock' as const,
    hostname: 'app.example.com',
    path: '/admin',
    match: 'prefix' as const,
    ips: ['203.0.113.10'],
  };

  it('adds a limit after the rules already there, as a block for everyone not listed', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', ruleset: customRuleset }],
    });

    const rules = await service.createCustomRule(ZONE_ID, {
      description: 'Only listed IPs, app.example.com/admin*',
      spec: lock,
    });

    expect(fake.writes()[0].body).toEqual({
      description: 'Only listed IPs, app.example.com/admin*',
      expression:
        '(http.host eq "app.example.com" and starts_with(http.request.uri.path, "/admin") and not ip.src in {203.0.113.10})',
      action: 'block',
      enabled: true,
    });
    expect(rules.map((rule) => rule.description)).toEqual([
      'Block Tor exit nodes',
      'Only listed IPs, app.example.com/admin*',
    ]);
  });

  it('changes a limit in place and keeps it switched off when it was', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', ruleset: customRuleset }],
    });
    const added = await service.createCustomRule(ZONE_ID, {
      description: 'Only listed IPs, app.example.com/admin*',
      spec: lock,
    });
    const id = added[1].id;
    await service.setCustomRuleEnabled(ZONE_ID, id, false);

    const rules = await service.updateCustomRule(ZONE_ID, id, {
      description: 'Only listed IPs, app.example.com',
      spec: { ...lock, path: null, ips: ['203.0.113.10', '198.51.100.0/24'] },
    });

    expect(fake.writes().at(-1)).toMatchObject({
      method: 'PATCH',
      path: `/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/${id}`,
      body: {
        description: 'Only listed IPs, app.example.com',
        expression: `(http.host eq "app.example.com" and ${ACME} and not ip.src in {203.0.113.10 198.51.100.0/24})`,
        action: 'block',
        enabled: false,
      },
    });
    expect(rules.map((rule) => rule.id)).toEqual([RULE_ID, id]);
    expect(rules[1]).toMatchObject({
      enabled: false,
      description: 'Only listed IPs, app.example.com',
    });
  });

  it('never rewrites a rule that is not an IP limit, or into something that is not one', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', ruleset: customRuleset }],
    });
    await expect(
      service.updateCustomRule(ZONE_ID, RULE_ID, { description: 'x', spec: lock }),
    ).rejects.toThrow('Runova only changes the IP limits it made. Change this rule in Cloudflare.');
    await expect(
      service.updateCustomRule(ZONE_ID, RULE_ID, {
        description: 'x',
        spec: { kind: 'block-countries', countries: ['CN'] },
      }),
    ).rejects.toThrow('Only an IP limit can be changed here.');
    await expect(
      service.updateCustomRule(ZONE_ID, RULE_ID, { description: 'x', spec: { ...lock, ips: [] } }),
    ).rejects.toThrow(/at least one IP address/);
    expect(fake.writes()).toEqual([]);
  });

  it('says a limit is gone when someone removed it at Cloudflare', async () => {
    const { service } = await connectedService();
    await expect(
      service.updateCustomRule(ZONE_ID, RULE_ID, { description: 'x', spec: lock }),
    ).rejects.toThrow(/not in this zone any more/);
  });
});

describe('IP access rules (T4)', () => {
  it('lists, creates and deletes rules, working out the target from the value', async () => {
    const { service, fake } = await connectedService({
      zones: [{ id: ZONE_ID, name: 'example.com', accessRules: [accessRule] }],
    });

    expect(await service.listAccessRules(ZONE_ID)).toEqual([
      {
        id: ACCESS_RULE_ID,
        mode: 'block',
        target: 'ip',
        value: '198.51.100.4',
        notes: 'This rule is enabled because of an event that occurred on date X.',
        createdOn: '2014-01-01T05:20:00.12345Z',
      },
    ]);

    const created = await service.createAccessRule(ZONE_ID, {
      mode: 'managed_challenge',
      value: '203.0.113.0/24',
      notes: 'Office',
    });
    expect(created).toMatchObject({
      mode: 'managed_challenge',
      target: 'ip_range',
      value: '203.0.113.0/24',
    });
    expect(fake.writes()[0].body).toEqual({
      mode: 'managed_challenge',
      configuration: { target: 'ip_range', value: '203.0.113.0/24' },
      notes: 'Office',
    });

    await service.deleteAccessRule(ZONE_ID, ACCESS_RULE_ID);
    expect(fake.zones.get(ZONE_ID)?.accessRules.map((rule) => rule.id)).toEqual([created.id]);
  });

  it('refuses a value an access rule cannot hold', async () => {
    const { service } = await connectedService();
    await expect(
      service.createAccessRule(ZONE_ID, { mode: 'block', value: '203.0.0.0/8', notes: '' }),
    ).rejects.toThrow(/16 or \/24/);
  });

  it('names Firewall Services when the token cannot manage access rules', async () => {
    const { service } = await connectedService({
      token: { grants: { ...ALL_GRANTS, accessRules: undefined } },
    });
    const error = await rejection(service.listAccessRules(ZONE_ID));
    expect(cloudflareErrorPermission(error)).toBe('accessRules');
  });
});

describe('point domain to this server (T5, AC2)', () => {
  const INPUT = { zoneId: ZONE_ID, name: '@', serverId: 'srv-1', includeWww: true, proxied: true };

  it('plans the address records for the name and its www from the server addresses', async () => {
    const { service, addresses, fake } = await connectedService();

    const plan = await service.planPointDomain(INPUT);

    expect(addresses).toHaveBeenCalledWith('srv-1');
    expect(plan).toMatchObject({
      zoneName: 'example.com',
      names: ['example.com', 'www.example.com'],
      addresses: { ipv4: ['203.0.113.10'], ipv6: ['2001:db8::10'] },
      upToDate: false,
    });
    expect(plan.changes.map((change) => `${change.action} ${change.type} ${change.name}`)).toEqual([
      'create A example.com',
      'create AAAA example.com',
      'create A www.example.com',
      'create AAAA www.example.com',
    ]);
    expect(fake.writes()).toEqual([]);
  });

  it("points at the server's Cloudflare Tunnel while it has one (E95), and only once", async () => {
    const harness = makeService({ zones: [{ id: ZONE_ID, name: 'example.com' }] });
    await harness.service.saveToken({ token: TOKEN });
    const tunnel = harness.service.withTunnelTarget(
      async () => '6ff42ae2-765d-4adf-8112-31c55c1551ef.cfargotunnel.com',
    );
    harness.fake.requests.length = 0;

    const plan = await tunnel.planPointDomain(INPUT);
    await tunnel.pointDomain(INPUT);
    const again = await tunnel.planPointDomain(INPUT);

    expect(plan.tunnel).toBe('6ff42ae2-765d-4adf-8112-31c55c1551ef.cfargotunnel.com');
    expect(
      plan.changes.map(
        (change) => `${change.action} ${change.type} ${change.name} ${change.proxied}`,
      ),
    ).toEqual(['create CNAME example.com true', 'create CNAME www.example.com true']);
    expect(harness.addresses).not.toHaveBeenCalled();
    expect(again.upToDate).toBe(true);
    expect(
      harness.fake.zones.get(ZONE_ID)?.records.map((record) => `${record.type} ${record.name}`),
    ).toEqual(['CNAME example.com', 'CNAME www.example.com']);
  });

  it('applies the plan in one batch, and a second run changes nothing', async () => {
    const { service, fake } = await connectedService();

    const first = await service.pointDomain(INPUT);
    expect(first.applied).toBe(4);
    expect(fake.writes()).toHaveLength(1);
    expect(fake.writes()[0]).toMatchObject({
      method: 'POST',
      path: `/zones/${ZONE_ID}/dns_records/batch`,
    });

    const second = await service.pointDomain(INPUT);
    expect(second.applied).toBe(0);
    expect(second.plan.upToDate).toBe(true);
    expect(second.plan.changes.every((change) => change.action === 'keep')).toBe(true);
    expect(fake.writes()).toHaveLength(1);
    expect(
      fake.zones
        .get(ZONE_ID)
        ?.records.map((record) => `${record.type} ${record.name} ${record.content}`),
    ).toEqual([
      'A example.com 203.0.113.10',
      'AAAA example.com 2001:db8::10',
      'A www.example.com 203.0.113.10',
      'AAAA www.example.com 2001:db8::10',
    ]);
  });

  it('replaces a CNAME and repoints an old address in the same batch', async () => {
    const { service, fake } = await connectedService({
      zones: [
        {
          id: ZONE_ID,
          name: 'example.com',
          records: [
            { ...dnsRecord, content: '198.51.100.4' },
            {
              ...dnsRecord,
              id: 'b'.repeat(32),
              type: 'CNAME',
              name: 'www.example.com',
              content: 'example.com',
            },
          ],
        },
      ],
    });

    const result = await service.pointDomain({ ...INPUT, proxied: false });

    expect(
      result.plan.changes.map((change) => `${change.action} ${change.type} ${change.name}`),
    ).toEqual([
      'update A example.com',
      'create AAAA example.com',
      'delete CNAME www.example.com',
      'create A www.example.com',
      'create AAAA www.example.com',
    ]);
    expect(fake.writes()[0].body).toMatchObject({
      deletes: [{ id: 'b'.repeat(32) }],
      patches: [
        {
          id: dnsRecord.id,
          type: 'A',
          name: 'example.com',
          content: '203.0.113.10',
          proxied: false,
          ttl: 1,
        },
      ],
    });
    expect((await service.planPointDomain({ ...INPUT, proxied: false })).upToDate).toBe(true);
  });

  it('refuses a name that cannot be pointed, and passes on an address problem', async () => {
    const { service, addresses } = await connectedService();
    await expect(service.planPointDomain({ ...INPUT, name: 'bad name' })).rejects.toThrow(
      /cannot be used/,
    );
    addresses.mockRejectedValueOnce(new Error('10.0.0.5 is a private or local address'));
    await expect(service.planPointDomain(INPUT)).rejects.toThrow(/private or local/);
  });
});
