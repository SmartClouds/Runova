import { describe, expect, it } from 'vitest';
import type { StoredRdpServer } from '../../../shared/apiTypes';
import { memorySecrets, sealed } from '../testing/memorySecrets';
import { rdpServersAdapter } from './rdpServers';

function server(overrides: Partial<StoredRdpServer> = {}): StoredRdpServer {
  return {
    id: 'r1',
    nickname: 'Office',
    host: 'office.example.com',
    port: 3389,
    username: 'me',
    certFingerprint: 'AB:CD',
    options: {
      resolution: 'fitWindow',
      fullscreenOnConnect: false,
      maximizeOnConnect: true,
      clipboard: true,
      fileTransfer: false,
      nla: true,
    },
    createdAt: 1,
    lastConnectedAt: 7,
    secretEnvelope: sealed('rdp-password'),
    ...overrides,
  };
}

function memoryStore(initial: StoredRdpServer[] = []) {
  let servers = structuredClone(initial);
  return {
    getRdpServers: async () => structuredClone(servers),
    setRdpServers: async (next: StoredRdpServer[]) => {
      servers = structuredClone(next);
    },
    get: () => servers,
  };
}

describe('rdpServersAdapter', () => {
  it('lists a server with its password opened and its certificate pin', async () => {
    const [item] = await rdpServersAdapter(memoryStore([server()]), memorySecrets()).list();

    expect(item?.value.secretEnvelope).toEqual({ $secret: 'rdp-password' });
    expect(item?.value.certFingerprint).toBe('AB:CD');
  });

  it('seals the password here and starts with no last connection', async () => {
    const store = memoryStore();
    const { lastConnectedAt: _last, ...shared } = server();

    await rdpServersAdapter(store, memorySecrets()).apply({
      id: 'r1',
      teamId: null,
      value: { ...shared, secretEnvelope: { $secret: 'rdp-password' } },
    });

    expect(store.get()[0]?.secretEnvelope).toEqual(sealed('rdp-password'));
    expect(store.get()[0]?.lastConnectedAt).toBeNull();
  });

  it('keeps this computer’s last connection on an update', async () => {
    const store = memoryStore([server()]);

    await rdpServersAdapter(store, memorySecrets()).apply({
      id: 'r1',
      teamId: null,
      value: { ...server({ nickname: 'Office PC' }), lastConnectedAt: 99 },
    });

    expect(store.get()[0]).toMatchObject({ nickname: 'Office PC', lastConnectedAt: 7 });
  });
});
