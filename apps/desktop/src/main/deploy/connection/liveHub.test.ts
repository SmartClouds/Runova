import { afterEach, describe, expect, it } from 'vitest';
import { TunnelRefusedError } from '../../ssh/connection';
import { HubStartError, startLiveHub } from './liveHub';
import { type FakeHubServer, startFakeHubServer } from './testing/fakeHubServer';
import { type CoreTransport, devTcpTransport } from './transport';

/**
 * The connection a server's lasting link keeps open: it never reconnects by itself (the link
 * opens a fresh one, through a fresh SSH connection if need be), it says when it has closed, and
 * a failure to start says why in a way the link can act on.
 */

let server: FakeHubServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('startLiveHub', () => {
  it('answers through the generated client and settles `closed` when the core drops it', async () => {
    server = await startFakeHubServer();
    const session = await startLiveHub(devTcpTransport(server.port), 't0k', 1_000);

    expect(await session.hub.ping()).toEqual({ serverTimeUnixMs: 123 });
    expect(session.expiresAt).toBe(1_000);
    expect(server.upgrades[0].headers.authorization).toBe('Bearer t0k');

    server.drop();
    await session.closed;
  });

  it("keeps the transport's own Host, which nginx picks the core domain's site by", async () => {
    server = await startFakeHubServer();
    const session = await startLiveHub(
      { ...devTcpTransport(server.port), host: () => 'core.example.com' },
      't0k',
      null,
    );

    expect(server.upgrades[0].headers.host).toBe('core.example.com');
    await session.stop();
  });

  it('settles `closed` when stopped', async () => {
    server = await startFakeHubServer();
    const session = await startLiveHub(devTcpTransport(server.port), 't0k', null);

    await session.stop();

    await session.closed;
  });

  it('keeps the status of a refused upgrade, so a 401 can be told from a 503', async () => {
    server = await startFakeHubServer({ refuseWith: 503 });

    const failure = await startLiveHub(devTcpTransport(server.port), 't0k', null).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HubStartError);
    expect((failure as HubStartError).status).toBe(503);
  });

  it("hands back the tunnel's own error when the stream to the core cannot open", async () => {
    const refused = new TunnelRefusedError('no tunnel for you', 1);
    const transport: CoreTransport = {
      kind: 'streamlocal',
      openStream: async () => {
        throw refused;
      },
    };

    await expect(startLiveHub(transport, 't0k', null)).rejects.toBe(refused);
  });
});
