import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import { coreErrorCode } from '../../shared/coreErrors';
import type {
  ChallengeResponse,
  HealthResponse,
  SignedInResponse,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FAKE_CORE_TLS_PIN, FakeCore } from '../../shared/deploy/testing/fakeCore';
import type { DeployCoreRecord } from '../../shared/deployTypes';
import { createDeviceKey } from './auth/deviceKey';
import { CoreRequestTooLargeError } from './connection/coreHttp';
import type { LiveHubSession } from './connection/liveHub';
import type { CoreTransport, CoreTransportKind } from './connection/transport';
import { CLOUDFLARE_MAX_REQUEST_BYTES, CoreDomainUnreachableError } from './coreDomain/transport';
import { DirectTlsUnreachableError, PinMismatchError } from './directTls/transport';
import { DeployService, type DeployServiceDeps } from './service';
import { DeployState } from './state';

/**
 * The fallback order with the core domain on (E44): the domain through nginx first, then direct
 * TLS when that is on too, then the SSH tunnel as before. Each way in that does not answer is
 * left alone for a while on its own, and the pin rules of direct TLS still hold behind the domain.
 */

const RECORD: DeployCoreRecord = {
  version: '1.53.0',
  release: '/opt/runova-core/releases/1.53.0',
  transport: 'streamlocal',
  installedAt: 1,
  os: 'Ubuntu 24.04.1 LTS',
  architecture: 'x86_64',
};
const SAVED = [
  {
    id: 'srv-1',
    nickname: 'Production',
    host: 'prod.example',
    port: 22,
    username: 'deployer',
    authMethod: 'password' as const,
  },
];
const HEALTH: HealthResponse = {
  status: 'ok',
  version: '1.53.0',
  apiVersion: 1,
  startedAtUnixMs: 1,
};

let service: DeployService | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  service?.links.closeAll();
  service = null;
  vi.useRealTimers();
});

type Outcome = unknown | ((transport: CoreTransport) => unknown);

interface Setup {
  /** Whether this computer has direct TLS on for the server. */
  direct?: boolean;
  /** Whether this computer connects through the core domain first. */
  domain?: boolean;
  /** How the domain is reached; straight to the server unless said. */
  domainMode?: 'direct' | 'cloudflare';
  /** Fails the next lasting opens, in order. */
  refusals?: Outcome[];
  /** What a health check over each transport kind throws, if anything. */
  health?: Partial<Record<CoreTransportKind, unknown>>;
}

async function setup(options: Setup = {}) {
  const core = new FakeCore(() => Date.now());
  const pool = {
    acquire: vi.fn(async () => ({ connection: {} as never, release: () => undefined })),
    reset: vi.fn(),
  };
  let content: unknown = null;
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  const sealed = (text: string): SecretEnvelope => ({
    mode: 'safeStorage',
    ciphertext: Buffer.from(text).toString('base64'),
  });
  await state.set('srv-1', RECORD);
  await state.setDevice('srv-1', {
    deviceId: 'device-1',
    userName: 'maria',
    privateKey: sealed(createDeviceKey().privateKeyPem),
    sessionId: 'session-1',
  });
  if (options.domain !== false) {
    await state.setCoreDomain('srv-1', {
      enabled: true,
      domain: 'core.example.com',
      ...(options.domainMode ? { mode: options.domainMode } : {}),
    });
  }
  if (options.direct !== false) {
    await state.setDirectTls('srv-1', {
      enabled: true,
      port: 7443,
      pin: FAKE_CORE_TLS_PIN,
      pinnedAt: 1,
    });
  }
  let issued = 0;
  const rest = {
    post: async <T>(path: string): Promise<T> => {
      if (path === '/api/v1/auth/challenge') {
        return {
          challengeId: 'c1',
          nonce: 'n1',
          expiresAtUnixMs: 0,
        } satisfies ChallengeResponse as T;
      }
      issued += 1;
      return {
        sessionId: 'session-1',
        accessToken: `token-${issued}`,
        accessTokenExpiresAtUnixMs: Date.now() + 15 * 60_000,
        user: { id: 'u1', userName: 'maria', roles: ['owner'], twoFactorEnabled: false },
      } satisfies SignedInResponse as T;
    },
  };
  const refusals = [...(options.refusals ?? [])];
  const opened: CoreTransportKind[] = [];
  const restOver: CoreTransportKind[] = [];
  const shortOver: CoreTransportKind[] = [];
  const liveHub = async (
    transport: CoreTransport,
    _token: string,
    expiresAt: number | null,
  ): Promise<LiveHubSession> => {
    opened.push(transport.kind);
    const next = refusals.shift();
    const refusal = typeof next === 'function' ? next(transport) : next;
    if (refusal) throw refusal;
    const connection = core.connect();
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    connection.onClose(() => markClosed());
    return { hub: connection, closed, stop: () => connection.stop(), expiresAt };
  };
  const deps: DeployServiceDeps = {
    servers: async () => SAVED,
    pool,
    state,
    releases: { release: async () => Promise.reject(new Error('not in this test')) },
    availableVersion: async () => '1.53.0',
    devCorePort: null,
    progress: () => undefined,
    seal: async (text) => sealed(text),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    healthOf: async (transport) => {
      const failure = options.health?.[transport.kind];
      if (failure) throw failure;
      return HEALTH;
    },
    rest: (transport) => {
      restOver.push(transport.kind);
      return rest;
    },
    hub: async (transport) => {
      shortOver.push(transport.kind);
      const connection = core.connect();
      return { hub: connection, stop: () => connection.stop() };
    },
    liveHub,
  };
  service = new DeployService(deps);
  return { service, core, pool, state, opened, restOver, shortOver };
}

const domainDown = () =>
  new CoreDomainUnreachableError('Could not reach core.example.com: ECONNREFUSED');
const directDown = () =>
  new DirectTlsUnreachableError('Could not reach the direct TLS port: ECONNREFUSED');
const mismatch = () => new PinMismatchError(FAKE_CORE_TLS_PIN, 'other', 'prod.example:7443');

describe('DeployService with the core domain', () => {
  it('opens the link through the domain first, without an SSH connection, and says so', async () => {
    const { service, opened, pool } = await setup();

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened).toEqual(['core-domain']);
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(service.connection('srv-1')).toMatchObject({
      state: 'online',
      transport: 'core-domain',
    });
  });

  it('sends the domain as Host so nginx picks the core site', async () => {
    const hosts: (string | undefined)[] = [];
    const { service } = await setup({
      refusals: [
        (transport: CoreTransport) => {
          hosts.push(transport.host?.());
          return null;
        },
      ],
    });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(hosts).toEqual(['core.example.com']);
  });

  it('tries direct TLS when the domain does not answer, then SSH, each left alone on its own', async () => {
    const { service, opened, core } = await setup({ refusals: [domainDown(), directDown()] });

    await service.links.call('srv-1', (hub) => hub.ping());
    expect(opened).toEqual(['core-domain', 'direct-tls', 'streamlocal']);

    core.dropAll();
    await vi.advanceTimersByTimeAsync(5_000);
    await service.links.call('srv-1', (hub) => hub.ping());
    expect(opened.slice(3)).toEqual(['streamlocal']);

    core.dropAll();
    await vi.advanceTimersByTimeAsync(61_000);
    await service.links.call('srv-1', (hub) => hub.ping());
    expect(opened.at(-1)).toBe('core-domain');
  });

  it('goes to SSH when only the domain is on and it does not answer', async () => {
    const { service, opened } = await setup({ direct: false, refusals: [domainDown()] });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened).toEqual(['core-domain', 'streamlocal']);
  });

  it('skips the domain while this computer has it off', async () => {
    const { service, opened } = await setup({ domain: false });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened).toEqual(['direct-tls']);
  });

  it('reaches a domain through Cloudflare with the transport that signs each request', async () => {
    const seen: { host: string | undefined; limit: number | undefined }[] = [];
    const { service } = await setup({
      domainMode: 'cloudflare',
      refusals: [
        (transport: CoreTransport) => {
          seen.push({ host: transport.host?.(), limit: transport.maxRequestBytes });
          return null;
        },
      ],
    });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(seen).toEqual([{ host: 'core.example.com', limit: CLOUDFLARE_MAX_REQUEST_BYTES }]);
    expect(service.connection('srv-1')).toMatchObject({ transport: 'core-domain' });
  });

  it("sends an upload over Cloudflare's limit through direct TLS, or SSH without it", async () => {
    const tooLarge = async (kinds: CoreTransportKind[], direct: boolean) => {
      const { service } = await setup({ domainMode: 'cloudflare', direct });
      return service.withCoreHttp('srv-1', async (client) => {
        kinds.push(client.transport.kind);
        if (client.transport.maxRequestBytes !== undefined) {
          throw new CoreRequestTooLargeError('Over the limit.', client.transport.maxRequestBytes);
        }
        return 'sent';
      });
    };
    const withDirect: CoreTransportKind[] = [];
    const sshOnly: CoreTransportKind[] = [];

    expect(await tooLarge(withDirect, true)).toBe('sent');
    expect(await tooLarge(sshOnly, false)).toBe('sent');
    expect(withDirect).toEqual(['core-domain', 'direct-tls']);
    expect(sshOnly).toEqual(['core-domain', 'streamlocal']);
  });

  it('still stops on a pin mismatch behind a domain that did not answer', async () => {
    const { service, opened, pool } = await setup({ refusals: [domainDown(), mismatch()] });

    const error = await service.links
      .call('srv-1', (hub) => hub.ping())
      .catch((caught: unknown) => caught);

    expect(coreErrorCode(error)).toBe('tlsPinMismatch');
    expect(opened).toEqual(['core-domain', 'direct-tls']);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('checks health through the domain, and through the next way in when it does not answer', async () => {
    const up = await setup();
    expect((await up.service.health('srv-1')).transport).toBe('core-domain');
    expect(up.pool.acquire).not.toHaveBeenCalled();
    up.service.links.closeAll();

    const down = await setup({ health: { 'core-domain': domainDown() } });
    expect((await down.service.health('srv-1')).transport).toBe('direct-tls');
    down.service.links.closeAll();

    const both = await setup({
      health: { 'core-domain': domainDown(), 'direct-tls': directDown() },
    });
    expect((await both.service.health('srv-1')).transport).toBe('streamlocal');
  });

  it('sends short calls through the domain once its health answers', async () => {
    const { service } = await setup();

    const seen = await service.withCoreHttp('srv-1', async (client) => client.transport.kind);

    expect(seen).toBe('core-domain');
  });

  it('reads the direct TLS pin over SSH even while the link rides the domain', async () => {
    const { service, shortOver } = await setup();
    await service.links.call('srv-1', (hub) => hub.ping());

    await service.withSshHub('srv-1', (hub) => hub.getDirectTls());

    expect(shortOver).toEqual(['streamlocal']);
  });

  it('starts the link over again after a change to the domain', async () => {
    const { service, opened, state } = await setup({ domain: false, direct: false });
    await service.links.call('srv-1', (hub) => hub.ping());
    expect(service.connection('srv-1').transport).toBe('streamlocal');

    await state.setCoreDomain('srv-1', { enabled: true, domain: 'core.example.com' });
    service.coreDomainChanged('srv-1');
    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened.at(-1)).toBe('core-domain');
  });
});
