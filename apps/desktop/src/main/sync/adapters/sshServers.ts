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
      const server = shared as unknown as StoredSshServer;
      // The same rule as an edit on this computer (ipc/ssh.ts): a server that now points somewhere
      // else is trusted again only after the person checks its host key on the next connect.
      const moved = existing && (existing.host !== server.host || existing.port !== server.port);
      if (moved) delete (server as Partial<StoredSshServer>).hostKeyFingerprint;
      return {
        ...server,
        ...(existing?.privateKeyPath ? { privateKeyPath: existing.privateKeyPath } : {}),
        lastConnectedAt: existing?.lastConnectedAt ?? null,
      };
    },
    duplicate: (value) => ({ ...value, nickname: fromAnotherComputer(value.nickname) }),
  });
}
