import { MANAGE_METHODS } from '@runova/protocol';
import { describe, expect, it, vi } from 'vitest';
import { permissionDeniedMessage } from '../../../shared/cloudflare/permissions';
import { encodeCloudflareError } from '../../../shared/cloudflareErrors';
import type {
  CloudflareDnsRecord,
  CloudflareStatus,
  CloudflareZone,
  CloudflareZoneSettings,
} from '../../../shared/cloudflareTypes';
import { cloudflareMethods, type ManageCloudflareDeps } from './cloudflareMethods';
import { ManageError } from './session';

/**
 * Cloudflare for a phone (E98): the desktop's own Cloudflare service, behind named parameters that
 * are checked the same way the desktop's IPC checks them. Failures come back in words, with what
 * to do about a token that lacks a permission.
 */

const context = { phone: { key: 'k', name: 'Runova app', scopes: ['cloudflare' as const] } };
const ZONE = '023e105f4ecef8ad9ca31a8372d0c353';
const RECORD = '372e67954025e0ba6aaa6d586b9e0b59';
const TOKEN = 'Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M';

const STATUS: CloudflareStatus = {
  configured: true,
  locked: false,
  accounts: [
    {
      id: 'acct-1',
      label: 'Work',
      locked: false,
      report: {
        tokenId: 't1',
        status: 'active',
        expiresOn: null,
        source: 'probes',
        permissions: [
          { id: 'zone', state: 'granted' },
          { id: 'dns', state: 'granted' },
          { id: 'waf', state: 'missing' },
          { id: 'cachePurge', state: 'unverified' },
        ],
        zoneCount: 2,
        checkedAt: 1_700_000_000_000,
      },
    },
    { id: 'acct-2', label: 'Home', locked: true, report: null },
  ],
};

const ZONE_ROW: CloudflareZone = {
  id: ZONE,
  accountId: 'acct-1',
  cloudflareAccountId: '01a7362d577a6c3019a474fd6f485823',
  name: 'example.com',
  status: 'active',
  paused: false,
  plan: 'Free Website',
  nameServers: ['bob.ns.cloudflare.com', 'lola.ns.cloudflare.com'],
};

const A_RECORD: CloudflareDnsRecord = {
  id: RECORD,
  type: 'A',
  name: 'example.com',
  content: '203.0.113.10',
  ttl: 1,
  proxied: true,
  proxiable: true,
  editable: true,
};

const SETTINGS = { developmentMode: { value: 'off' } } as unknown as CloudflareZoneSettings;

function deps(change: Partial<ManageCloudflareDeps['service']> = {}): ManageCloudflareDeps {
  return {
    service: {
      status: vi.fn(async () => STATUS),
      saveToken: vi.fn(async () => STATUS),
      checkToken: vi.fn(async () => STATUS),
      removeToken: vi.fn(async () => STATUS),
      listZones: vi.fn(async () => [ZONE_ROW]),
      cloudflareAccounts: vi.fn(async () => [{ id: ZONE_ROW.cloudflareAccountId, name: 'Acme' }]),
      createZone: vi.fn(async () => ZONE_ROW),
      checkActivation: vi.fn(async () => undefined),
      listRecords: vi.fn(async () => [A_RECORD]),
      createRecord: vi.fn(async () => A_RECORD),
      updateRecord: vi.fn(async () => A_RECORD),
      deleteRecord: vi.fn(async () => undefined),
      zoneSettings: vi.fn(async () => SETTINGS),
      changeSetting: vi.fn(async () => SETTINGS),
      botSettings: vi.fn(async () => ({
        aiBots: 'disabled' as const,
        aiLabyrinth: false,
        preferenceSync: false,
        fightMode: false,
      })),
      changeBotSetting: vi.fn(async () => ({
        aiBots: 'block' as const,
        aiLabyrinth: false,
        preferenceSync: false,
        fightMode: false,
      })),
      planPointDomain: vi.fn(async () => ({
        zoneName: 'example.com',
        names: ['example.com'],
        addresses: { ipv4: ['203.0.113.10'], ipv6: [] },
        changes: [],
        upToDate: true,
      })),
      pointDomain: vi.fn(async () => ({
        plan: {
          zoneName: 'example.com',
          names: ['example.com'],
          addresses: { ipv4: ['203.0.113.10'], ipv6: [] },
          changes: [],
          upToDate: true,
        },
        applied: 2,
      })),
      ...change,
    },
    servers: async () => [
      { id: 'srv-1', name: 'prod' },
      { id: 'dev', name: 'This computer' },
    ],
  };
}

function call(d: ManageCloudflareDeps, method: string, params?: unknown) {
  return cloudflareMethods(d)[method](params, context);
}

async function failure(promise: unknown): Promise<ManageError> {
  try {
    await promise;
  } catch (error) {
    return error as ManageError;
  }
  throw new Error('expected the call to fail');
}

describe('cloudflare methods', () => {
  it('declares every method it handles, under the cloudflare scope', () => {
    for (const name of Object.keys(cloudflareMethods(deps()))) {
      expect(MANAGE_METHODS[name], name).toMatchObject({ scope: 'cloudflare' });
    }
    expect(MANAGE_METHODS['cloudflare.saveToken']).toEqual({
      scope: 'cloudflare',
      risk: 'danger',
      audited: true,
    });
    expect(MANAGE_METHODS['cloudflare.deleteRecord']?.risk).toBe('danger');
    expect(MANAGE_METHODS['cloudflare.records']?.risk).toBe('read');
  });

  it('says how each account stands, with its permissions in words and no token', async () => {
    const status = (await call(deps(), 'cloudflare.status')) as {
      accounts: Record<string, unknown>[];
    };

    expect(status).toEqual({
      configured: true,
      locked: false,
      accounts: [
        {
          id: 'acct-1',
          label: 'Work',
          locked: false,
          state: 'active',
          expiresOn: null,
          zoneCount: 2,
          checkedAt: 1_700_000_000_000,
          missing: ['Zone > Zone WAF > Edit'],
          unverified: ['Zone > Cache Purge > Purge'],
        },
        {
          id: 'acct-2',
          label: 'Home',
          locked: true,
          state: null,
          expiresOn: null,
          zoneCount: null,
          checkedAt: null,
          missing: [],
          unverified: [],
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('t1');
  });

  it('saves a pasted token, checks one again and removes one', async () => {
    const d = deps();
    await call(d, 'cloudflare.saveToken', { token: ` ${TOKEN}\n`, label: 'Phone' });
    await call(d, 'cloudflare.saveToken', { token: TOKEN, accountId: 'acct-1' });
    await call(d, 'cloudflare.checkToken', { accountId: 'acct-1' });
    await call(d, 'cloudflare.removeToken', { accountId: 'acct-2' });

    expect(d.service.saveToken).toHaveBeenCalledWith({ token: TOKEN, label: 'Phone' });
    expect(d.service.saveToken).toHaveBeenCalledWith({ token: TOKEN, accountId: 'acct-1' });
    expect(d.service.checkToken).toHaveBeenCalledWith('acct-1');
    expect(d.service.removeToken).toHaveBeenCalledWith('acct-2');
  });

  it('lists zones, the accounts a domain can go into, and adds one', async () => {
    const d = deps();
    expect(await call(d, 'cloudflare.zones', { accountId: 'acct-1' })).toEqual([ZONE_ROW]);
    expect(await call(d, 'cloudflare.accounts', { accountId: 'acct-1' })).toEqual([
      { id: ZONE_ROW.cloudflareAccountId, name: 'Acme' },
    ]);
    await call(d, 'cloudflare.createZone', {
      accountId: 'acct-1',
      name: 'https://new.example/',
      cloudflareAccountId: ZONE_ROW.cloudflareAccountId,
    });
    await call(d, 'cloudflare.checkActivation', { zoneId: ZONE });

    expect(d.service.createZone).toHaveBeenCalledWith('acct-1', {
      name: 'new.example',
      cloudflareAccountId: ZONE_ROW.cloudflareAccountId,
    });
    expect(d.service.checkActivation).toHaveBeenCalledWith(ZONE);
  });

  it('reads and changes DNS records', async () => {
    const d = deps();
    const record = {
      type: 'A',
      name: 'app.example.com',
      content: '203.0.113.10',
      ttl: 1,
      proxied: true,
    };
    expect(await call(d, 'cloudflare.records', { zoneId: ZONE })).toEqual([A_RECORD]);
    await call(d, 'cloudflare.createRecord', { zoneId: ZONE, record: { ...record, extra: 1 } });
    await call(d, 'cloudflare.updateRecord', { zoneId: ZONE, recordId: RECORD, record });
    await call(d, 'cloudflare.deleteRecord', { zoneId: ZONE, recordId: RECORD });

    expect(d.service.createRecord).toHaveBeenCalledWith(ZONE, record);
    expect(d.service.updateRecord).toHaveBeenCalledWith(ZONE, RECORD, record);
    expect(d.service.deleteRecord).toHaveBeenCalledWith(ZONE, RECORD);
  });

  it('reads and changes zone and bot settings', async () => {
    const d = deps();
    await call(d, 'cloudflare.zoneSettings', { zoneId: ZONE });
    await call(d, 'cloudflare.changeSetting', {
      zoneId: ZONE,
      change: { setting: 'securityLevel', value: 'under_attack' },
    });
    await call(d, 'cloudflare.botSettings', { zoneId: ZONE });
    await call(d, 'cloudflare.changeBotSetting', {
      zoneId: ZONE,
      change: { setting: 'aiBots', value: 'block' },
    });

    expect(d.service.changeSetting).toHaveBeenCalledWith(ZONE, {
      setting: 'securityLevel',
      value: 'under_attack',
    });
    expect(d.service.changeBotSetting).toHaveBeenCalledWith(ZONE, {
      setting: 'aiBots',
      value: 'block',
    });
  });

  it('points a domain at a saved server, never at this computer', async () => {
    const d = deps();
    expect(await call(d, 'cloudflare.servers')).toEqual([{ id: 'srv-1', name: 'prod' }]);
    const input = { zoneId: ZONE, name: '@', serverId: 'srv-1', includeWww: true, proxied: true };
    await call(d, 'cloudflare.planPointDomain', input);
    expect(await call(d, 'cloudflare.pointDomain', input)).toMatchObject({ applied: 2 });
    expect(d.service.pointDomain).toHaveBeenCalledWith(input);
  });

  it('refuses parameters of the wrong shape before Cloudflare sees them', async () => {
    const d = deps();
    const bad = [
      call(d, 'cloudflare.zones', { accountId: '../x' }),
      call(d, 'cloudflare.records', { zoneId: 'nope' }),
      call(d, 'cloudflare.saveToken', { token: 'short' }),
      call(d, 'cloudflare.createRecord', {
        zoneId: ZONE,
        record: { type: 'A', name: 'a', content: 'not an address', ttl: 1, proxied: true },
      }),
      call(d, 'cloudflare.changeSetting', { zoneId: ZONE, change: { setting: 'ssl', value: 'x' } }),
      call(d, 'cloudflare.deleteRecord', { zoneId: ZONE }),
      call(d, 'cloudflare.records'),
    ];
    for (const attempt of bad) {
      const error = await failure(attempt);
      expect(error).toBeInstanceOf(ManageError);
      expect(error.code).toBe('bad-params');
    }
    expect(d.service.listRecords).not.toHaveBeenCalled();
    expect(d.service.createRecord).not.toHaveBeenCalled();
    expect(d.service.deleteRecord).not.toHaveBeenCalled();
  });

  it('says what Cloudflare refused in words, without the code tag', async () => {
    const d = deps({
      listRecords: vi.fn(async () => {
        throw new Error(
          encodeCloudflareError('missing-permission', permissionDeniedMessage('dns'), 'dns'),
        );
      }),
      zoneSettings: vi.fn(async () => {
        throw new Error('Cloudflare is busy.');
      }),
    });

    const missing = await failure(call(d, 'cloudflare.records', { zoneId: ZONE }));
    expect(missing.code).toBe('failed');
    expect(missing.message).toBe(
      'This token is not allowed to change DNS records. On Cloudflare, edit the token and add Zone > DNS > Edit, then check it again here.',
    );
    const busy = await failure(call(d, 'cloudflare.zoneSettings', { zoneId: ZONE }));
    expect(busy).toMatchObject({ code: 'failed', message: 'Cloudflare is busy.' });
  });
});
