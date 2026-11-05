import { syncCollection } from '@runova/core';
import type { StoredSshServer } from '../../../shared/apiTypes';
import { arrayStoreAdapter, type SecretPort } from './arrayStore';
import { fromAnotherComputer } from './copyName';

export interface SshServerStorePort {
  getSshServers: () => Promise<StoredSshServer[]>;
  setSshServers: (servers: StoredSshServer[]) => Promise<void>;
}

/**
 * Saved SSH servers (E48). The key file path and the last connection belong to this computer: a
 * server that arrives from another one has no key file here until the person picks one. The host
 * key pin syncs, since it is just as useful on every computer. The password or passphrase travels
 * only sealed.
 */
export function sshServersAdapter(
  store: SshServerStorePort,
  secrets: SecretPort,
  ready?: () => boolean,
) {
  return arrayStoreAdapter<StoredSshServer>({
    collection: syncCollection('ssh-servers'),
    area: 'ssh',
    read: () => store.getSshServers(),
    write: (servers) => store.setSshServers(servers),
    id: (server) => server.id,
    secrets,
    ...(ready ? { ready } : {}),
    fromValue: (value, existing) => {
      const { privateKeyPath: _path, lastConnectedAt: _last, ...shared } = value;
      return {
        ...(shared as unknown as StoredSshServer),
        ...(existing?.privateKeyPath ? { privateKeyPath: existing.privateKeyPath } : {}),
        lastConnectedAt: existing?.lastConnectedAt ?? null,
      };
    },
    duplicate: (value) => ({ ...value, nickname: fromAnotherComputer(value.nickname) }),
  });
}
