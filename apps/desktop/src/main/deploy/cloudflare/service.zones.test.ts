import { describe, expect, it } from 'vitest';
import { cloudflareErrorCode, cloudflareErrorPermission } from '../../../shared/cloudflareErrors';
import { ALL_GRANTS } from './testing/fakeCloudflare';
import { ACCOUNT, connectedService, TOKEN } from './testing/harness';
import { CF_ACCOUNT_ID, ZONE_ID } from './testing/recorded';

/**
 * Adding a domain from the page: Cloudflare makes a new zone in the account the user picked, which
 * waits for the registrar to use Cloudflare's name servers. Making one, and asking Cloudflare to
 * look at the name servers again, need Zone > Zone > Edit, which the main token does not ask for.
 */

const GRANTS = { ...ALL_GRANTS, zone: 'edit' } as const;
const OTHER_CF_ACCOUNT = '5f1e2d3c4b5a69788796a5b4c3d2e1f0';

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail');
}

describe('adding a domain', () => {
  it('makes a full zone in the chosen Cloudflare account and hands back its name servers', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    const zone = await service.createZone(ACCOUNT, {
      name: 'new-site.org',
      cloudflareAccountId: CF_ACCOUNT_ID,
    });
    expect(zone).toMatchObject({
      accountId: ACCOUNT,
      cloudflareAccountId: CF_ACCOUNT_ID,
      name: 'new-site.org',
      status: 'pending',
      paused: false,
    });
    expect(zone.nameServers).toHaveLength(2);
    expect(zone.id).toMatch(/^[0-9a-f]{32}$/);
    const [write] = fake.writes();
    expect(write).toMatchObject({ method: 'POST', path: '/zones' });
    expect(write?.body).toEqual({
      account: { id: CF_ACCOUNT_ID },
      name: 'new-site.org',
      type: 'full',
    });
  });

  it('cleans up a pasted address the same way the page does', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    const zone = await service.createZone(ACCOUNT, {
      name: 'https://New-Site.ORG/about',
      cloudflareAccountId: CF_ACCOUNT_ID,
    });
    expect(zone.name).toBe('new-site.org');
    expect(fake.writes()[0]?.body).toMatchObject({ name: 'new-site.org' });
  });

  it('remembers the new zone, so its DNS opens without listing the zones again', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    const zone = await service.createZone(ACCOUNT, {
      name: 'new-site.org',
      cloudflareAccountId: CF_ACCOUNT_ID,
    });
    fake.requests.length = 0;
    await expect(service.listRecords(zone.id)).resolves.toEqual([]);
    expect(fake.requests.map((request) => request.path)).toEqual([`/zones/${zone.id}/dns_records`]);
    expect((await service.listZones(ACCOUNT)).map((listed) => listed.name)).toContain(
      'new-site.org',
    );
  });

  it('refuses a name that is not a domain before asking Cloudflare', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    const error = await rejection(
      service.createZone(ACCOUNT, { name: 'localhost', cloudflareAccountId: CF_ACCOUNT_ID }),
    );
    expect(error.message).toBe('Add the ending too, like example.com.');
    expect(fake.requests).toHaveLength(0);
  });

  it('names Zone Edit when the token may only read zones, and leaves the report alone', async () => {
    const { service } = await connectedService();
    const before = await service.status();
    const error = await rejection(
      service.createZone(ACCOUNT, { name: 'new-site.org', cloudflareAccountId: CF_ACCOUNT_ID }),
    );
    expect(cloudflareErrorCode(error)).toBe('missing-permission');
    expect(cloudflareErrorPermission(error)).toBe('zoneEdit');
    expect(error.message).toContain('Zone > Zone > Edit');
    expect(await service.status()).toEqual(before);
  });

  it('says in words when the domain is already on Cloudflare', async () => {
    const { service } = await connectedService({ token: { grants: GRANTS } });
    const error = await rejection(
      service.createZone(ACCOUNT, { name: 'Example.com', cloudflareAccountId: CF_ACCOUNT_ID }),
    );
    expect(error.message).toBe(
      'example.com is already on Cloudflare, in this account or another one. If it is in another account, remove it there first.',
    );
  });

  it('says in words when Cloudflare cannot find the domain registered', async () => {
    const { service } = await connectedService({ token: { grants: GRANTS } });
    const error = await rejection(
      service.createZone(ACCOUNT, {
        name: 'not-bought-yet.invalid',
        cloudflareAccountId: CF_ACCOUNT_ID,
      }),
    );
    expect(error.message).toBe(
      'Cloudflare could not find not-bought-yet.invalid as a registered domain. Check the spelling, and if you just bought it, try again in a few minutes.',
    );
  });

  it('passes on any other refusal in Cloudflare words, with the token scrubbed', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    fake.failNext(/^\/zones$/, 400, {
      success: false,
      errors: [{ code: 1105, message: `Bad zone for ${TOKEN}` }],
      messages: [],
      result: null,
    });
    const error = await rejection(
      service.createZone(ACCOUNT, { name: 'new-site.org', cloudflareAccountId: CF_ACCOUNT_ID }),
    );
    expect(error.message).toBe('Cloudflare said: Bad zone for [token] (code 1105)');
  });
});

describe('the Cloudflare accounts a domain can go into', () => {
  it("lists the token's accounts by name", async () => {
    const { service } = await connectedService({ token: { grants: GRANTS } });
    expect(await service.cloudflareAccounts(ACCOUNT)).toEqual([
      { id: CF_ACCOUNT_ID, name: 'Demo Account' },
    ]);
  });

  it('adds the accounts its zones are in, once each', async () => {
    const { service } = await connectedService({
      token: { grants: GRANTS },
      zones: [
        { id: ZONE_ID, name: 'example.com' },
        {
          id: '9a7806061c88ada191ed06f989cc3dac',
          name: 'example.net',
          cloudflareAccountId: OTHER_CF_ACCOUNT,
        },
      ],
    });
    expect(await service.cloudflareAccounts(ACCOUNT)).toEqual([
      { id: CF_ACCOUNT_ID, name: 'Demo Account' },
      { id: OTHER_CF_ACCOUNT, name: 'Demo Account' },
    ]);
  });

  it("falls back to the zones' accounts when the token may not list accounts", async () => {
    const { service } = await connectedService({
      token: { grants: GRANTS, canListAccounts: false },
    });
    expect(await service.cloudflareAccounts(ACCOUNT)).toEqual([
      { id: CF_ACCOUNT_ID, name: 'Demo Account' },
    ]);
  });

  it('explains what to change when no account can be found at all', async () => {
    const { service } = await connectedService({
      token: { grants: GRANTS, canListAccounts: false },
      zones: [],
    });
    const error = await rejection(service.cloudflareAccounts(ACCOUNT));
    expect(error.message).toBe(
      'Cloudflare did not name an account this token can add domains to. On Cloudflare, edit the token so its zone resources include all zones from your account, then try again.',
    );
  });
});

describe('checking the name servers again', () => {
  it("asks Cloudflare to look at a pending zone's name servers now", async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    await service.checkActivation(ZONE_ID);
    expect(fake.writes()).toMatchObject([
      { method: 'PUT', path: `/zones/${ZONE_ID}/activation_check` },
    ]);
  });

  it('names Zone Edit when the token may only read zones', async () => {
    const { service } = await connectedService();
    const error = await rejection(service.checkActivation(ZONE_ID));
    expect(cloudflareErrorPermission(error)).toBe('zoneEdit');
  });

  it('says how often Cloudflare allows a check when it was asked too soon', async () => {
    const { service, fake } = await connectedService({ token: { grants: GRANTS } });
    fake.failNext(/activation_check$/, 429, {
      success: false,
      errors: [{ code: 1224, message: 'You can only check once an hour' }],
      messages: [],
      result: null,
    });
    const error = await rejection(service.checkActivation(ZONE_ID));
    expect(error.message).toBe(
      'Cloudflare was asked to check recently and allows only a few checks an hour. It keeps checking on its own, so try again later.',
    );
  });
});
