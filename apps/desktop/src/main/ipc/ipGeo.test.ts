import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpGeoInfo } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The public IP and country shown on the dashboard. Every window and widget asks for it, so the
 * answer is cached and concurrent lookups are collapsed into one request. That is the part worth
 * testing: without it the app would hammer a free endpoint once per card.
 */

useTempUserData();
expectChannelsCovered(IPC.ipGeo);

const fetchMock = vi.fn();

async function register(): Promise<void> {
  await loadIpc(
    () => import('./ipGeo'),
    (module) => module.registerIpGeoHandlers(),
  );
}

function reply(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(reply({ ip: '203.0.113.7', country: 'Iran', country_code: 'IR' }));
  vi.stubGlobal('fetch', fetchMock);
  await register();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('IP geolocation', () => {
  it('reports the address and country the endpoint returned', async () => {
    const info = await invoke<IpGeoInfo>(IPC.ipGeo.lookup);

    expect(info).toEqual({ ip: '203.0.113.7', country: 'Iran', countryCode: 'IR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than hanging when the network stalls', async () => {
    await invoke(IPC.ipGeo.lookup);

    // The request carries an abort signal. Without one, a captive portal or dropped packets
    // leave the IPC promise pending and the dashboard card loading forever.
    const [, options] = fetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers the second caller from the cache', async () => {
    await invoke(IPC.ipGeo.lookup);
    await invoke(IPC.ipGeo.lookup);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again when the caller forces a refresh', async () => {
    await invoke(IPC.ipGeo.lookup);

    await invoke(IPC.ipGeo.lookup, true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses lookups that arrive together into one request', async () => {
    // Every widget asks on startup, and they all arrive before the first answer comes back.
    let settle: ((value: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );

    const first = invoke<IpGeoInfo>(IPC.ipGeo.lookup);
    const second = invoke<IpGeoInfo>(IPC.ipGeo.lookup);
    settle?.(reply({ ip: '198.51.100.4', country: 'Germany', country_code: 'DE' }));

    expect(await first).toEqual(await second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails when the endpoint answers with an error status', async () => {
    fetchMock.mockResolvedValue(reply({}, false));

    await expect(invoke(IPC.ipGeo.lookup)).rejects.toThrow(/503/);
  });

  it('fills in what a partial or wrongly typed answer leaves out', async () => {
    // A captive portal can answer 200 with something that is not the expected shape.
    fetchMock.mockResolvedValue(reply({ ip: 42 }));

    await expect(invoke(IPC.ipGeo.lookup)).resolves.toEqual({
      ip: '',
      country: 'Unknown',
      countryCode: '',
    });
  });

  it('refuses a body that is not an object at all', async () => {
    fetchMock.mockResolvedValue(reply('nope'));

    await expect(invoke(IPC.ipGeo.lookup)).rejects.toThrow(/response shape/);
  });

  it('lets a later caller retry after a failed lookup', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(invoke(IPC.ipGeo.lookup)).rejects.toThrow('offline');

    // The in-flight promise has to be cleared on failure, or the app never asks again.
    await expect(invoke(IPC.ipGeo.lookup)).resolves.toMatchObject({ ip: '203.0.113.7' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers with the fixed demo address in an e2e run that sets one', async () => {
    // The website screenshots must never show the real public IP of the machine that took them.
    vi.stubEnv('RUNOVA_E2E', '1');
    vi.stubEnv(
      'RUNOVA_E2E_IP_GEO',
      JSON.stringify({ ip: '203.0.113.24', country: 'Netherlands', countryCode: 'NL' }),
    );

    await expect(invoke(IPC.ipGeo.lookup, true)).resolves.toEqual({
      ip: '203.0.113.24',
      country: 'Netherlands',
      countryCode: 'NL',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores the demo address outside an e2e run', async () => {
    vi.stubEnv('RUNOVA_E2E', '');
    vi.stubEnv('RUNOVA_E2E_IP_GEO', JSON.stringify({ ip: '203.0.113.24' }));

    await expect(invoke(IPC.ipGeo.lookup, true)).resolves.toMatchObject({ ip: '203.0.113.7' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
