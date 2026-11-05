import { syncCollection } from '@runova/core';
import type { StoredRdpServer } from '../../../shared/apiTypes';
import { arrayStoreAdapter, type SecretPort } from './arrayStore';
import { fromAnotherComputer } from './copyName';

export interface RdpServerStorePort {
  getRdpServers: () => Promise<StoredRdpServer[]>;
  setRdpServers: (servers: StoredRdpServer[]) => Promise<void>;
}

/**
 * Saved Remote Desktop servers (E48). Only the last connection is this computer's own; nothing
 * about an RDP server is a local path. The certificate pin syncs like an SSH host key does, and
 * the password travels only sealed.
 */
export function rdpServersAdapter(
  store: RdpServerStorePort,
  secrets: SecretPort,
  ready?: () => boolean,
) {
  return arrayStoreAdapter<StoredRdpServer>({
    collection: syncCollection('rdp-servers'),
    area: 'rdp',
    read: () => store.getRdpServers(),
    write: (servers) => store.setRdpServers(servers),
    id: (server) => server.id,
    secrets,
    ...(ready ? { ready } : {}),
    fromValue: (value, existing) => ({
      ...(value as unknown as StoredRdpServer),
      lastConnectedAt: existing?.lastConnectedAt ?? null,
    }),
    duplicate: (value) => ({ ...value, nickname: fromAnotherComputer(value.nickname) }),
  });
}
