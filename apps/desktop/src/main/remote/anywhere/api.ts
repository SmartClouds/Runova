import type {
  AnywhereDirectoryEntry,
  AnywherePlatform,
  AnywhereSessionRecord,
  AnywhereThisDevice,
} from '../../../shared/anywhere';

type Request = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { headers?: Record<string, string> },
) => Promise<T>;

export interface RegisteredDevice extends AnywhereThisDevice {
  allowOwnDevices: boolean;
  unattendedEnabled: boolean;
  teamIds: number[];
}

export interface DeviceSettingsPatch {
  name?: string;
  allowOwnDevices?: boolean;
  unattendedEnabled?: boolean;
  teamIds?: number[];
}

/** The website's Runova Anywhere routes (E60), through the signed-in account client. */
export function createAnywhereApi(request: Request) {
  return {
    register: (input: {
      deviceId: string;
      name: string;
      platform: AnywherePlatform;
      identityKey: string;
    }) => request<RegisteredDevice>('POST', '/remote-devices', input),

    /** A merge patch: fields left out stay as they are. */
    update: (id: number, patch: DeviceSettingsPatch) =>
      request<RegisteredDevice>('PATCH', `/remote-devices/${id}`, patch),

    remove: (id: number) => request<void>('DELETE', `/remote-devices/${id}`),

    reachable: () =>
      request<{ mine: AnywhereDirectoryEntry[]; teammates: AnywhereDirectoryEntry[] }>(
        'GET',
        '/reachable-devices',
      ),

    async teams(): Promise<{ id: number; name: string }[]> {
      const teams = await request<{ items: { id: number; name: string }[] }>('GET', '/teams');
      return teams.items.map(({ id, name }) => ({ id, name }));
    },

    async sessions(page = 1, pageSize = 50): Promise<AnywhereSessionRecord[]> {
      return (
        await request<{ items: AnywhereSessionRecord[] }>(
          'GET',
          `/remote-sessions?page=${page}&pageSize=${pageSize}`,
        )
      ).items;
    },

    deleteSession: (id: number) => request<void>('DELETE', `/remote-sessions/${id}`),
  };
}

export type AnywhereApi = ReturnType<typeof createAnywhereApi>;
