import { describe, expect, it, vi } from 'vitest';
import { createAnywhereApi } from './api';

function fakeRequest(responses: Record<string, unknown> = {}) {
  const calls: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }[] = [];
  const request = vi.fn(
    async (
      method: string,
      path: string,
      body?: unknown,
      options?: { headers?: Record<string, string> },
    ) => {
      calls.push({ method, path, body, ...(options?.headers ? { headers: options.headers } : {}) });
      return responses[`${method} ${path}`] as never;
    },
  );
  return { request, calls };
}

describe('Runova Anywhere API client', () => {
  it('registers this computer with its key, and nothing secret', async () => {
    const device = { id: 7, remoteId: '482193775', name: 'Desk', platform: 'windows' };
    const { request, calls } = fakeRequest({ 'POST /remote-devices': device });

    const result = await createAnywhereApi(request).register({
      deviceId: 'd-1',
      name: 'Desk',
      platform: 'windows',
      identityKey: 'key',
    });

    expect(result).toEqual(device);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/remote-devices',
      body: { deviceId: 'd-1', name: 'Desk', platform: 'windows', identityKey: 'key' },
    });
  });

  it('sends settings as a merge patch', async () => {
    const { request, calls } = fakeRequest();

    await createAnywhereApi(request).update(7, { allowOwnDevices: true, teamIds: [2] });

    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/remote-devices/7',
      body: { allowOwnDevices: true, teamIds: [2] },
    });
  });

  it('reads the reachable computers, the teams and the session history', async () => {
    const { request } = fakeRequest({
      'GET /reachable-devices': { mine: [], teammates: [{ id: 1 }] },
      'GET /teams': { items: [{ id: 2, name: 'Ops', role: 'owner' }] },
      'GET /remote-sessions?page=1&pageSize=50': { items: [{ id: 3 }], total: 1 },
    });
    const api = createAnywhereApi(request);

    expect(await api.reachable()).toEqual({ mine: [], teammates: [{ id: 1 }] });
    expect(await api.teams()).toEqual([{ id: 2, name: 'Ops' }]);
    expect(await api.sessions()).toEqual([{ id: 3 }]);
  });

  it('deletes a session record and removes a computer by id', async () => {
    const { request, calls } = fakeRequest();
    const api = createAnywhereApi(request);

    await api.deleteSession(3);
    await api.remove(7);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /remote-sessions/3',
      'DELETE /remote-devices/7',
    ]);
  });
});
