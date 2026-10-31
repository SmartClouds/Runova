import { describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { FAKE_CORE_PASSWORD, FakeCore } from '../../../shared/deploy/testing/fakeCore';
import type { DeployCoreDomainCheck } from '../../../shared/deployCoreDomainTypes';
import type { CoreTransport } from '../connection/transport';
import { DeployState } from '../state';
import { DeployCoreDomain } from './service';

function memoryState(): DeployState {
  let content: unknown = null;
  return new DeployState({
    read: async () => content,
    write: async (value) => {
      content = JSON.parse(JSON.stringify(value));
    },
  });
}

const PASSED: DeployCoreDomainCheck = { ok: true, checkedAt: 5_000 };
const PROXIED: DeployCoreDomainCheck = {
  ok: false,
  checkedAt: 5_000,
  problem: 'cloudflare-proxy',
  message: 'Cloudflare answers for core.example.com.',
};

function setup(options: { roles?: string[]; check?: DeployCoreDomainCheck } = {}) {
  const core = new FakeCore(() => 1_000);
  core.roles = options.roles ?? ['owner'];
  const state = memoryState();
  const changed = vi.fn();
  const checked: string[] = [];
  /** Whether this computer still tried the domain when each call went out. */
  const localEnabled: Array<boolean | undefined> = [];
  const coreDomain = new DeployCoreDomain({
    service: {
      withHub: async <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => {
        localEnabled.push((await state.coreDomain(serverId))?.enabled);
        return work(core.connect());
      },
      coreDomainChanged: changed,
      coreDomainTransport: async (_serverId, domain) =>
        ({ kind: 'core-domain', host: () => domain }) as unknown as CoreTransport,
    },
    state,
    roles: () => core.roles,
    check: async (_transport, domain) => {
      checked.push(domain);
      return options.check ?? PASSED;
    },
    now: () => 5_000,
  });
  return { core, state, coreDomain, changed, checked, localEnabled };
}

/** Gives the fake core a certificate for its domain, as an issued one would. */
function issueCertificate(core: FakeCore): void {
  const status = core.coreDomain;
  core.coreDomain = {
    ...status,
    ready: true,
    certificate: {
      siteId: 'runova-core',
      source: 'acme',
      state: 'valid',
      domains: [status.domain ?? ''],
      issuer: "Let's Encrypt",
      notBeforeUnixMs: 0,
      notAfterUnixMs: 9_000_000_000_000,
      autoRenew: true,
      staging: false,
      failedAttempts: 0,
    },
  };
}

describe('DeployCoreDomain', () => {
  it('reads the mode and keeps no route while it is off', async () => {
    const { coreDomain, state, checked } = setup();

    const info = await coreDomain.status('srv');

    expect(info.status.enabled).toBe(false);
    expect(info.route).toBeNull();
    expect(info.check).toBeUndefined();
    expect(checked).toEqual([]);
    expect(await state.coreDomain('srv')).toBeNull();
  });

  it('turns it on with a step-up, and waits for a certificate before this computer uses it', async () => {
    const { coreDomain, state, core, checked } = setup();

    const info = await coreDomain.enable({
      serverId: 'srv',
      domain: 'core.example.com',
      sources: [],
      password: FAKE_CORE_PASSWORD,
    });

    expect(core.coreDomain.enabled).toBe(true);
    expect(info.status.ready).toBe(false);
    expect(info.route).toEqual({ enabled: false, domain: 'core.example.com' });
    expect(checked).toEqual([]);
    expect(await state.coreDomain('srv')).toEqual(info.route);
  });

  it('checks the domain from here once it is ready and uses it when the check passes', async () => {
    const { coreDomain, core, changed, checked } = setup();
    await coreDomain.enable({
      serverId: 'srv',
      domain: 'core.example.com',
      sources: [],
      password: FAKE_CORE_PASSWORD,
    });
    issueCertificate(core);
    changed.mockClear();

    const first = await coreDomain.status('srv');
    const second = await coreDomain.status('srv');

    expect(first.check).toEqual(PASSED);
    expect(first.route).toEqual({ enabled: true, domain: 'core.example.com' });
    expect(second.route?.enabled).toBe(true);
    expect(checked).toEqual(['core.example.com']);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps this computer off a domain behind the Cloudflare proxy and says why', async () => {
    const { coreDomain, core } = setup({ check: PROXIED });
    await coreDomain.enable({
      serverId: 'srv',
      domain: 'core.example.com',
      sources: [],
      password: FAKE_CORE_PASSWORD,
    });
    issueCertificate(core);

    const info = await coreDomain.check('srv');

    expect(info.route).toEqual({ enabled: false, domain: 'core.example.com' });
    expect(info.check).toEqual(PROXIED);
  });

  it('stops using the domain before it asks the core to take it out', async () => {
    const { coreDomain, core, state, changed, localEnabled } = setup();
    await coreDomain.enable({
      serverId: 'srv',
      domain: 'core.example.com',
      sources: [],
      password: FAKE_CORE_PASSWORD,
    });
    issueCertificate(core);
    await coreDomain.status('srv');
    expect((await state.coreDomain('srv'))?.enabled).toBe(true);
    changed.mockClear();
    localEnabled.length = 0;

    const info = await coreDomain.disable('srv');

    expect(localEnabled).toEqual([false]);
    expect(changed).toHaveBeenCalled();
    expect(info.status.enabled).toBe(false);
    expect(info.route?.enabled).toBe(false);
    expect(info.check).toBeUndefined();
  });

  it('says a step-up is needed, and that only an Owner can turn it on', async () => {
    const owner = setup();
    const needsStepUp = await owner.coreDomain
      .enable({ serverId: 'srv', domain: 'core.example.com', sources: [] })
      .catch((error: unknown) => error);

    const admin = setup({ roles: ['admin'] });
    const forbidden = await admin.coreDomain
      .enable({
        serverId: 'srv',
        domain: 'core.example.com',
        sources: [],
        password: FAKE_CORE_PASSWORD,
      })
      .catch((error: unknown) => error);

    expect(coreErrorCode(needsStepUp)).toBe('stepUpRequired');
    expect(coreErrorCode(forbidden)).toBe('forbidden');
  });
});
