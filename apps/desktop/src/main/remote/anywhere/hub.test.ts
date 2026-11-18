import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The SignalR connection the hub builds, with the calls it was asked to make. */
const connection = vi.hoisted(() => ({
  invoke: vi.fn(async (_method: string, ..._args: unknown[]) => undefined as unknown),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  on: vi.fn(),
  onreconnected: vi.fn(),
  onreconnecting: vi.fn(),
  onclose: vi.fn(),
  state: 'Connected',
}));

vi.mock('@microsoft/signalr', () => {
  class Builder {
    withUrl() {
      return this;
    }
    withAutomaticReconnect() {
      return this;
    }
    configureLogging() {
      return this;
    }
    build() {
      return connection;
    }
  }
  return {
    HubConnectionBuilder: Builder,
    HubConnectionState: { Connected: 'Connected', Disconnected: 'Disconnected' },
    LogLevel: { None: 6 },
  };
});

const { websiteAnywhereHub } = await import('./hub');

function hub() {
  return websiteAnywhereHub({ siteUrl: 'https://runovahq.test', accessToken: async () => 't' });
}

beforeEach(() => vi.clearAllMocks());

describe('going online on the remote hub (E112)', () => {
  it('says what this app can do as it goes online', async () => {
    await hub().goOnline(7, ['receive-files']);

    expect(connection.invoke).toHaveBeenCalledWith('GoOnlineWithFeatures', 7, ['receive-files']);
    expect(connection.invoke).toHaveBeenCalledTimes(1);
  });

  it('goes online as an older app does on a website that does not know the call', async () => {
    connection.invoke.mockRejectedValueOnce(new Error('Method does not exist.'));

    await hub().goOnline(7, ['receive-files']);

    expect(connection.invoke.mock.calls).toEqual([
      ['GoOnlineWithFeatures', 7, ['receive-files']],
      ['GoOnline', 7],
    ]);
  });

  it('goes online the old way when it has nothing to say', async () => {
    await hub().goOnline(7);

    expect(connection.invoke.mock.calls).toEqual([['GoOnline', 7]]);
  });
});
